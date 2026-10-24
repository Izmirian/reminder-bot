/**
 * WhatsApp send health — turns "every send is failing" from a silent
 * console.error into a single loud, deduplicated incident.
 *
 * Born from the 2026-10-24 outage: Meta deregistered the bot's number, every
 * send returned `(#133010) Account not registered`, and nothing noticed for a
 * day because the only alert path (src/monitor.js) was itself WhatsApp.
 *
 *  - classifyGraphError()  fatal (config/auth, needs a human) vs transient
 *                          (retry) vs permanent (this one message is doomed).
 *  - createIncidentTracker()  pure open/cooldown/recover state machine.
 *  - report*() + listener     process-wide singleton; src/monitor.js plugs in
 *                          an independent (non-WhatsApp) alert channel.
 *  - planMissedReminders()    keeps a long outage from dumping a flood of
 *                          stale reminders when sending recovers.
 *
 * Everything except the singleton is pure so it can be unit-tested.
 */
import { CONFIG } from './config.js';

const HOUR_MS = 3600 * 1000;

// Meta Cloud API error codes (developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes).
// Fatal = retrying is pointless until a human fixes the account, number or token.
const FATAL_CODES = new Set([
  0,       // AuthException — token invalidated
  3,       // capability / permissions issue
  10,      // permission denied
  190,     // access token expired / invalid
  368,     // temporarily blocked for policy violations
  131005,  // access denied
  131031,  // account locked / restricted
  131037,  // display name approval needed
  131045,  // phone number registration (certificate) error
  133000,  // incomplete deregistration
  133005,  // two-step PIN mismatch
  133006,  // number needs re-verification
  133010,  // phone number not registered  ← the 2026-10-24 incident
]);                                           // plus the 200–299 permission range, see isFatalCode()

// Transient = back off and retry; says nothing about account health.
const TRANSIENT_CODES = new Set([
  1, 2,    // unknown / temporary service error
  4,       // app rate limit
  80007,   // WABA rate limit
  130429,  // Cloud API throughput limit
  131000,  // unknown send error (Meta: retry once)
  131016,  // service unavailable
  131048,  // spam rate limit
  131056,  // pair rate limit
  131057,  // maintenance mode
  133004,  // server temporarily unavailable
  133008, 133009, // PIN guess throttling
]);

// Anything else (131030 recipient not in test allow-list, 131026 undeliverable,
// 131047 24h window, 100 bad parameter, …) is per-message/per-recipient: it must
// not raise an account-level incident, and retrying the same send won't help.

const isFatalCode = (c) => FATAL_CODES.has(c) || (c >= 200 && c <= 299);

/**
 * Classify a Graph API error response.
 * @param {number} status HTTP status
 * @param {*} body parsed JSON body (may be anything — never throws)
 * @returns {{kind: 'fatal'|'transient'|'permanent', code: number|null, reason: string}}
 */
export function classifyGraphError(status, body) {
  const e = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null;
  const n = e && e.code != null ? Number(e.code) : NaN;
  const code = Number.isInteger(n) ? n : null;
  const serverish = status === 429 || status >= 500;

  let kind;
  if (code !== null && isFatalCode(code)) kind = 'fatal';
  else if (code !== null && TRANSIENT_CODES.has(code)) kind = 'transient';
  else if (serverish) kind = 'transient';
  else if (code === null && status === 401) kind = 'fatal';
  else kind = 'permanent';

  let reason = typeof e?.message === 'string' && e.message ? e.message : `HTTP ${status}`;
  if (code !== null && !reason.includes(String(code))) reason = `(#${code}) ${reason}`;
  if (reason.length > 200) reason = reason.slice(0, 200) + '…';
  return { kind, code, reason };
}

/**
 * Should a failed one-off reminder send be left active for the missed-reminder
 * cron to retry? Everything except a permanent per-message failure is retryable
 * (fatal ones too — the reminder must survive until the account is fixed).
 */
export function isRetryableSendError(err) {
  return err?.waKind !== 'permanent';
}

/**
 * Pure incident state machine. Only `fatal` failures open an incident.
 * One alert when it opens, then at most one re-alert per cooldown; a
 * successful send closes it and reports recovery exactly once.
 */
export function createIncidentTracker({ cooldownMs = CONFIG.SEND_ALERT_COOLDOWN_HOURS * HOUR_MS } = {}) {
  let incident = null; // { since, lastAlertAt, failures, code, reason }
  return {
    isActive: () => incident !== null,
    reset() { incident = null; },
    reportFailure(info, now = Date.now()) {
      if (info?.kind !== 'fatal') return { alert: false };
      if (!incident) {
        incident = { since: now, lastAlertAt: now, failures: 1, code: info.code, reason: info.reason };
        return { alert: true, opened: true, ...incident };
      }
      incident.failures++;
      incident.code = info.code;
      incident.reason = info.reason;
      if (now - incident.lastAlertAt >= cooldownMs) {
        incident.lastAlertAt = now;
        return { alert: true, opened: false, ...incident };
      }
      return { alert: false };
    },
    reportSuccess(now = Date.now()) {
      if (!incident) return { recovered: false };
      const done = incident;
      incident = null;
      return { recovered: true, downMs: now - done.since, failures: done.failures, code: done.code, reason: done.reason };
    },
  };
}

// ---- process-wide singleton ------------------------------------------------

const tracker = createIncidentTracker();
let listener = {};

/** monitor.js registers the independent alert channel here: { onAlert(info), onRecover(info) }. */
export function setSendHealthListener(l) { listener = l || {}; }
export function isSendIncidentActive() { return tracker.isActive(); }
export function resetSendHealthForTests() { tracker.reset(); listener = {}; }

function notify(fn, info) {
  try {
    Promise.resolve(fn?.(info)).catch(e => console.error('[WA Health] listener failed:', e.message));
  } catch (e) { console.error('[WA Health] listener failed:', e.message); }
}

/** Called by api.js for every failed message send. */
export function reportSendFailure(info) {
  const r = tracker.reportFailure(info);
  if (!r.alert) return;
  console.error(`[ALERT] WhatsApp sends are failing with a fatal config/auth error: ${r.reason} (${r.failures} failure${r.failures === 1 ? '' : 's'} since incident start). Reminders will be held and retried; fix the number/token on the Meta dashboard.`);
  notify(listener.onAlert, r);
}

/** Called by api.js after every successful message send. */
export function reportSendSuccess() {
  const r = tracker.reportSuccess();
  if (!r.recovered) return;
  console.log(`[RECOVERED] WhatsApp sending works again after ${Math.round(r.downMs / 60000)} min (${r.failures} failed sends).`);
  notify(listener.onRecover, r);
}

// ---- missed-reminder planning ----------------------------------------------

/**
 * Decide what the every-2-min missed-reminder check should do with the
 * backlog of past-due, never-fired one-off reminders.
 *
 *  - fresh (overdue ≤ staleMs): fire individually, oldest first, at most
 *    maxPerTick per run so recovery doesn't burst (and trip Meta rate limits).
 *  - stale (overdue > staleMs): not worth individual pings — collapsed into a
 *    single digest message, sent only once no fresh reminders are waiting.
 *  - incident open: every send is a probe of whether the account works again,
 *    so attempt just one rather than hammering a known-broken API.
 */
export function planMissedReminders(missed, { now = Date.now(), staleMs, maxPerTick, incidentActive = false }) {
  const age = (r) => {
    const t = new Date(r.remind_at).getTime();
    return Number.isNaN(t) ? 0 : now - t; // unparseable → treat as fresh (legacy behaviour)
  };
  const sorted = [...missed].sort((a, b) => age(b) - age(a)); // oldest first
  const fresh = sorted.filter(r => age(r) <= staleMs);
  const stale = sorted.filter(r => age(r) > staleMs);
  const limit = incidentActive ? 1 : maxPerTick;
  const fire = fresh.slice(0, limit);
  return { fire, digest: fire.length === 0 ? stale : [] };
}

/** One catch-up message for reminders that came due while sending was down. */
export function buildMissedDigest(items, timezone) {
  const when = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const opts = { weekday: 'short', hour: 'numeric', minute: '2-digit' };
    try { return d.toLocaleString('en-US', { ...opts, timeZone: timezone }); }
    catch { return d.toLocaleString('en-US', { ...opts, timeZone: 'UTC' }); }
  };
  const n = items.length;
  let msg = `*Missed while I couldn't send messages* — ${n} reminder${n === 1 ? '' : 's'} came due:`;
  for (const r of items.slice(0, 10)) {
    const text = String(r.text || '').slice(0, 100);
    const w = when(r.remind_at);
    msg += `\n  • ${text}${w ? ` (${w})` : ''}`;
  }
  if (n > 10) msg += `\n  …and ${n - 10} more`;
  return msg;
}
