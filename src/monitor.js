/**
 * Reliability monitoring.
 *
 * Two layers:
 *  1. startHeartbeat() — pings an external dead-man's-switch (healthchecks.io
 *     or similar) every 2 min. If the process dies/crash-loops, the pings stop
 *     and the external service alerts the owner. Catches full outages.
 *  2. startSelfCheck() — while the process is alive, periodically probes the DB
 *     and alerts the owner (over WhatsApp) when it's unreachable. Catches the
 *     "alive but broken" case. Sends a recovery note when it comes back.
 *
 *  3. startSendHealthAlerts() — WhatsApp send failures that need a human (number
 *     deregistered, token expired — see src/wa-health.js) are reported through the
 *     SAME external healthchecks.io check, NOT through WhatsApp (which is exactly
 *     what is broken). On the first fatal failure we ping `<HEALTHCHECK_URL>/fail`
 *     and stop sending the success heartbeat while the incident is open, so the
 *     check stays down (one alert per incident; healthchecks.io owns dedupe and
 *     the recovery notice). The first successful send resumes the heartbeat.
 *
 * All layers are no-ops if their required env vars are unset, so the bot runs
 * fine locally without any monitoring configured.
 */
import { setSendHealthListener, isSendIncidentActive } from './wa-health.js';

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;  // 2 min
const SELFCHECK_INTERVAL_MS = 5 * 60 * 1000;  // 5 min
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;     // don't re-alert within 30 min
const DB_FAIL_THRESHOLD = 2;                  // consecutive failures before alerting

let dbConsecutiveFailures = 0;
let dbInIncident = false;
let lastAlertAt = 0;

/**
 * Build the healthchecks.io URL for a success ('ok') or explicit failure
 * ('fail') signal from the configured ping URL. Handles uuid and slug forms,
 * trailing slashes and query strings. Returns null if unset/invalid.
 * (Never log the result — the ping URL is a credential.)
 */
export function healthcheckPingUrl(base, kind = 'ok') {
  if (!base) return null;
  let u;
  try { u = new URL(base); } catch { return null; }
  if (kind === 'fail') u.pathname = u.pathname.replace(/\/+$/, '') + '/fail';
  return u.toString();
}

async function pingHealthcheck(kind, body) {
  const url = healthcheckPingUrl(process.env.HEALTHCHECK_URL, kind);
  if (!url) return;
  try {
    await fetch(url, { method: body ? 'POST' : 'GET', body: body || undefined, signal: AbortSignal.timeout(10000) });
  } catch (err) {
    // A failed ping just means this beat is missed; the external service
    // handles the alerting. Never let it crash the process, never log the URL.
    console.warn(`[Monitor] Healthcheck ${kind} ping failed:`, err.message);
  }
}

/**
 * Ping the external dead-man's-switch. Safe to call with no env configured.
 */
export function startHeartbeat() {
  if (!process.env.HEALTHCHECK_URL) {
    console.log('[Monitor] HEALTHCHECK_URL not set — external heartbeat disabled.');
    return;
  }
  const ping = async () => {
    // While a fatal WhatsApp send incident is open, withhold the success beat:
    // it would flip the check back to "up" and mask the incident.
    if (isSendIncidentActive()) return;
    await pingHealthcheck('ok');
    // Narrow race: the incident opened while that ping was in flight.
    if (isSendIncidentActive()) await pingHealthcheck('fail', 'WhatsApp send incident active');
  };
  ping(); // immediate first beat
  setInterval(ping, HEARTBEAT_INTERVAL_MS);
  console.log('[Monitor] External heartbeat started (every 2 min).');
}

/**
 * Route fatal WhatsApp send failures to the external healthcheck (see header).
 * wa-health.js already logs a loud [ALERT] line, so with no HEALTHCHECK_URL the
 * incident is still visible in the Railway logs, just not pushed anywhere.
 */
export function startSendHealthAlerts() {
  if (!process.env.HEALTHCHECK_URL) {
    console.log('[Monitor] HEALTHCHECK_URL not set — WhatsApp send failures will only be logged.');
    return;
  }
  setSendHealthListener({
    onAlert: (info) => pingHealthcheck('fail',
      `WhatsApp sends failing (fatal): ${info.reason}. ${info.failures} failed send(s) since ${new Date(info.since).toISOString()}.`),
    onRecover: () => pingHealthcheck('ok'),
  });
  console.log('[Monitor] WhatsApp send-failure alerts routed to the external healthcheck.');
}

/**
 * Send an alert to the owner over WhatsApp, with a cooldown so an ongoing
 * incident doesn't spam. `force` bypasses the cooldown (used for recovery).
 */
export async function alertOwner(message, { force = false } = {}) {
  const to = process.env.WHATSAPP_TO_NUMBER;
  if (!to) {
    console.warn('[Monitor] WHATSAPP_TO_NUMBER not set — cannot alert owner:', message);
    return;
  }
  const now = Date.now();
  if (!force && now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now;
  try {
    const { sendTextMessage } = await import('./whatsapp/api.js');
    await sendTextMessage(to, message);
  } catch (err) {
    console.error('[Monitor] Failed to send owner alert:', err.message);
  }
}

/**
 * Periodically probe the DB; alert on sustained failure, notify on recovery.
 */
export function startSelfCheck() {
  if (!process.env.WHATSAPP_TO_NUMBER) {
    console.log('[Monitor] WHATSAPP_TO_NUMBER not set — internal self-check alerts disabled.');
    return;
  }
  const check = async () => {
    try {
      const { pingDb } = await import('./db.js');
      await pingDb();
      // Healthy — if we were in an incident, announce recovery.
      if (dbInIncident) {
        dbInIncident = false;
        await alertOwner('✅ Bot recovered — database is reachable again.', { force: true });
      }
      dbConsecutiveFailures = 0;
    } catch (err) {
      dbConsecutiveFailures++;
      console.error(`[Monitor] DB self-check failed (${dbConsecutiveFailures}x):`, err.message);
      if (dbConsecutiveFailures >= DB_FAIL_THRESHOLD && !dbInIncident) {
        dbInIncident = true;
        await alertOwner(`⚠️ Bot can't reach the database (${dbConsecutiveFailures} failed checks). Reminders may not fire. Check Railway Postgres.`);
      }
    }
  };
  setInterval(check, SELFCHECK_INTERVAL_MS);
  console.log('[Monitor] Internal self-check started (every 5 min).');
}

/**
 * Called by the DB pool error handler to surface connection drops.
 */
export function signalDbError(message) {
  // Pool errors are often transient idle-connection drops; we don't alert
  // directly here (the periodic self-check decides), but we log for context.
  console.error('[Monitor] DB pool error observed:', message);
}
