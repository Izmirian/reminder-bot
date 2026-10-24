/**
 * Pure-logic unit tests for WhatsApp send-health: Graph error classification,
 * incident dedupe/cooldown/recovery, missed-reminder planning, and the
 * healthchecks.io fail-URL builder. No DB or network required — the one
 * api-level test stubs global fetch.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyGraphError, createIncidentTracker, isRetryableSendError,
  planMissedReminders, buildMissedDigest,
  reportSendFailure, reportSendSuccess, setSendHealthListener,
  isSendIncidentActive, resetSendHealthForTests,
} from '../src/wa-health.js';
import { healthcheckPingUrl } from '../src/monitor.js';

// The listener + incident state are process-wide singletons: isolate every test.
beforeEach(() => { resetSendHealthForTests(); });

const graphBody = (code, message = 'x', extra = {}) => ({ error: { message, type: 'OAuthException', code, fbtrace_id: 'abc', ...extra } });

// ---- classification --------------------------------------------------------

test('the 2026-10-24 incident body (133010 Account not registered) is fatal', () => {
  const c = classifyGraphError(400, graphBody(133010, '(#133010) Account not registered'));
  assert.equal(c.kind, 'fatal');
  assert.equal(c.code, 133010);
  assert.match(c.reason, /133010/);
  assert.match(c.reason, /Account not registered/);
});

test('invalid/expired token (190) and other auth/config codes are fatal', () => {
  for (const code of [0, 3, 10, 190, 200, 250, 299, 368, 131005, 131031, 131037, 131045, 133000, 133005, 133006, 133010]) {
    assert.equal(classifyGraphError(400, graphBody(code)).kind, 'fatal', `code ${code}`);
  }
});

test('HTTP status does not downgrade a fatal Graph code (190 arrives as 401)', () => {
  assert.equal(classifyGraphError(401, graphBody(190, 'Error validating access token')).kind, 'fatal');
});

test('rate-limit / outage codes are transient', () => {
  for (const code of [1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056, 131057, 133004, 133008, 133009]) {
    assert.equal(classifyGraphError(400, graphBody(code)).kind, 'transient', `code ${code}`);
  }
});

test('429 and 5xx are transient even without a parseable body', () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(classifyGraphError(status, {}).kind, 'transient', `status ${status}`);
    assert.equal(classifyGraphError(status, null).kind, 'transient', `status ${status} null body`);
  }
});

test('per-message failures are permanent, not fatal (no incident for one bad recipient)', () => {
  for (const code of [100, 131008, 131009, 131026, 131030, 131047, 131051, 132000]) {
    assert.equal(classifyGraphError(400, graphBody(code)).kind, 'permanent', `code ${code}`);
  }
  assert.equal(classifyGraphError(400, {}).kind, 'permanent');
  assert.equal(classifyGraphError(404, undefined).kind, 'permanent');
});

test('bare 401 with no body is fatal; bare 403 is not', () => {
  assert.equal(classifyGraphError(401, {}).kind, 'fatal');
  assert.equal(classifyGraphError(403, {}).kind, 'permanent');
});

test('classification never throws on odd bodies and keeps reason short', () => {
  for (const body of [null, undefined, 'oops', 42, [], { error: 'str' }, { error: { code: 'abc' } }]) {
    assert.doesNotThrow(() => classifyGraphError(400, body));
  }
  const long = classifyGraphError(400, graphBody(133010, 'x'.repeat(5000)));
  assert.ok(long.reason.length <= 240, `reason length ${long.reason.length}`);
});

test('isRetryableSendError: everything but a permanent per-message failure is retryable', () => {
  assert.equal(isRetryableSendError({ waKind: 'fatal' }), true);
  assert.equal(isRetryableSendError({ waKind: 'transient' }), true);
  assert.equal(isRetryableSendError(new Error('fetch failed')), true);   // network / DB blip: no waKind
  assert.equal(isRetryableSendError({ waKind: 'permanent' }), false);
  assert.equal(isRetryableSendError(null), true);
});

// ---- incident tracker ------------------------------------------------------

const fatal = { kind: 'fatal', code: 133010, reason: '(#133010) Account not registered' };
const HOUR = 3600 * 1000;

test('tracker raises ONE alert per incident, then stays quiet inside the cooldown', () => {
  const t = createIncidentTracker({ cooldownMs: 6 * HOUR });
  const first = t.reportFailure(fatal, 0);
  assert.equal(first.alert, true);
  assert.equal(first.opened, true);
  for (let i = 1; i <= 50; i++) {
    assert.equal(t.reportFailure(fatal, i * 60 * 1000).alert, false, `failure #${i + 1} should not re-alert`);
  }
  assert.equal(t.isActive(), true);
});

test('tracker re-alerts once the cooldown has elapsed, not before', () => {
  const t = createIncidentTracker({ cooldownMs: 6 * HOUR });
  t.reportFailure(fatal, 0);
  assert.equal(t.reportFailure(fatal, 6 * HOUR - 1).alert, false);
  const again = t.reportFailure(fatal, 6 * HOUR);
  assert.equal(again.alert, true);
  assert.equal(again.opened, false, 're-alert is a reminder, not a new incident');
  assert.equal(t.reportFailure(fatal, 6 * HOUR + 1000).alert, false, 'cooldown restarts after a re-alert');
});

test('transient and permanent failures never open an incident', () => {
  const t = createIncidentTracker();
  assert.equal(t.reportFailure({ kind: 'transient', code: 131016, reason: 'r' }, 0).alert, false);
  assert.equal(t.reportFailure({ kind: 'permanent', code: 131030, reason: 'r' }, 0).alert, false);
  assert.equal(t.isActive(), false);
});

test('a successful send closes the incident and reports recovery once', () => {
  const t = createIncidentTracker();
  t.reportFailure(fatal, 1000);
  t.reportFailure(fatal, 2000);
  const rec = t.reportSuccess(1000 + 14 * HOUR);
  assert.equal(rec.recovered, true);
  assert.equal(rec.downMs, 14 * HOUR);
  assert.equal(rec.failures, 2);
  assert.equal(t.isActive(), false);
  assert.equal(t.reportSuccess(1000 + 15 * HOUR).recovered, false, 'second success is not a second recovery');
});

test('success with no open incident is a no-op; a new incident after recovery alerts again', () => {
  const t = createIncidentTracker({ cooldownMs: 6 * HOUR });
  assert.equal(t.reportSuccess(0).recovered, false);
  t.reportFailure(fatal, 0);
  t.reportSuccess(1000);
  const next = t.reportFailure(fatal, 2000);   // well inside the old cooldown
  assert.equal(next.alert, true);
  assert.equal(next.opened, true);
});

// ---- singleton wiring + api.js integration ---------------------------------


test('listener gets one alert + one recovery across a burst of failures', () => {
  const events = [];
  setSendHealthListener({ onAlert: e => events.push(['alert', e.code]), onRecover: e => events.push(['recover', e.failures]) });
  for (let i = 0; i < 5; i++) reportSendFailure(fatal);
  assert.equal(isSendIncidentActive(), true);
  reportSendSuccess();
  reportSendSuccess();
  assert.deepEqual(events, [['alert', 133010], ['recover', 5]]);
  assert.equal(isSendIncidentActive(), false);
});

test('a throwing listener cannot break the send path', () => {
  setSendHealthListener({ onAlert() { throw new Error('boom'); }, onRecover() { throw new Error('boom'); } });
  assert.doesNotThrow(() => reportSendFailure(fatal));
  assert.doesNotThrow(() => reportSendSuccess());
});

test('sendTextMessage: 133010 throws a tagged error and opens an incident; next success recovers', async () => {
  const { sendTextMessage } = await import('../src/whatsapp/api.js');
  const events = [];
  setSendHealthListener({ onAlert: e => events.push('alert'), onRecover: e => events.push('recover') });
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify(graphBody(133010, '(#133010) Account not registered')), { status: 400, headers: { 'content-type': 'application/json' } });
    await assert.rejects(() => sendTextMessage('962790000000', 'hi'), (err) => {
      assert.match(err.message, /^WhatsApp API error 400:/);   // existing message format is preserved
      assert.match(err.message, /133010/);
      assert.equal(err.waKind, 'fatal');
      assert.equal(err.waCode, 133010);
      return true;
    });
    assert.equal(isSendIncidentActive(), true);

    globalThis.fetch = async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const ok = await sendTextMessage('962790000000', 'hi');
    assert.equal(ok.messages[0].id, 'wamid.X');
    assert.equal(isSendIncidentActive(), false);
    assert.deepEqual(events, ['alert', 'recover']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('sendTextMessage: a per-recipient 400 (131030) does not open an incident', async () => {
  const { sendTextMessage } = await import('../src/whatsapp/api.js');
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify(graphBody(131030, 'Recipient phone number not in allowed list')), { status: 400 });
    await assert.rejects(() => sendTextMessage('962790000000', 'hi'), (err) => err.waKind === 'permanent');
    assert.equal(isSendIncidentActive(), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- missed-reminder planning ----------------------------------------------

const NOW = Date.parse('2026-10-25T12:00:00Z');
const agoH = (h) => new Date(NOW - h * HOUR).toISOString();
const rem = (id, h, chat = '962790000000') => ({ id, text: `r${id}`, chat_id: chat, remind_at: agoH(h) });
const plan = (missed, opts = {}) => planMissedReminders(missed, { now: NOW, staleMs: 6 * HOUR, maxPerTick: 5, incidentActive: false, ...opts });

test('plan: recent reminders fire oldest-first; stale ones are held back for the digest', () => {
  const p = plan([rem(1, 0.2), rem(2, 3), rem(3, 20), rem(4, 30)]);
  assert.deepEqual(p.fire.map(r => r.id), [2, 1]);
  assert.deepEqual(p.digest, [], 'digest waits until the fresh ones have drained');
});

test('plan: with nothing fresh the whole stale backlog becomes ONE digest (no flood after a long outage)', () => {
  const backlog = Array.from({ length: 40 }, (_, i) => rem(i + 1, 24 + i));
  const p = plan(backlog);
  assert.equal(p.fire.length, 0);
  assert.equal(p.digest.length, 40);
});

test('plan: a burst of fresh reminders is rate-limited per tick', () => {
  const p = plan(Array.from({ length: 12 }, (_, i) => rem(i + 1, 1 + i / 100)), { maxPerTick: 5 });
  assert.equal(p.fire.length, 5);
});

test('plan: while an incident is open only ONE reminder is fired as a probe', () => {
  const p = plan([rem(1, 1), rem(2, 2), rem(3, 3)], { incidentActive: true });
  assert.deepEqual(p.fire.map(r => r.id), [3]);
});

test('plan: during an incident a stale-only backlog is attempted as a single digest probe', () => {
  const p = plan([rem(1, 10), rem(2, 11)], { incidentActive: true });
  assert.equal(p.fire.length, 0);
  assert.equal(p.digest.length, 2);
});

test('plan: unparseable remind_at is treated as fresh (old behaviour) and empty input is fine', () => {
  const p = plan([{ id: 9, chat_id: '1', text: 't', remind_at: 'not-a-date' }]);
  assert.deepEqual(p.fire.map(r => r.id), [9]);
  assert.deepEqual(plan([]), { fire: [], digest: [] });
});

test('digest message lists items, caps at 10, and uses the user timezone', () => {
  const items = Array.from({ length: 13 }, (_, i) => ({ text: `task ${i}`, remind_at: '2026-10-24T12:00:00Z' }));
  const msg = buildMissedDigest(items, 'Asia/Amman');
  assert.match(msg, /13 reminders/);
  assert.match(msg, /task 0/);
  assert.match(msg, /task 9/);
  assert.doesNotMatch(msg, /task 10/);
  assert.match(msg, /3 more/);
  assert.match(buildMissedDigest([items[0]], 'Asia/Amman'), /1 reminder\b/);
  assert.doesNotThrow(() => buildMissedDigest(items, 'Not/AZone'));
});

// ---- healthchecks.io URL builder -------------------------------------------

test('healthcheckPingUrl appends /fail to uuid, slug and query-string forms', () => {
  assert.equal(healthcheckPingUrl('https://hc-ping.com/abc-uuid', 'fail'), 'https://hc-ping.com/abc-uuid/fail');
  assert.equal(healthcheckPingUrl('https://hc-ping.com/abc-uuid/', 'fail'), 'https://hc-ping.com/abc-uuid/fail');
  assert.equal(healthcheckPingUrl('https://hc-ping.com/pingkey/my-slug', 'fail'), 'https://hc-ping.com/pingkey/my-slug/fail');
  assert.equal(healthcheckPingUrl('https://hc-ping.com/pingkey/my-slug?create=1', 'fail'), 'https://hc-ping.com/pingkey/my-slug/fail?create=1');
});

test('healthcheckPingUrl leaves the success URL untouched and survives garbage', () => {
  assert.equal(healthcheckPingUrl('https://hc-ping.com/abc-uuid', 'ok'), 'https://hc-ping.com/abc-uuid');
  assert.equal(healthcheckPingUrl('not a url', 'fail'), null);
  assert.equal(healthcheckPingUrl('', 'fail'), null);
  assert.equal(healthcheckPingUrl(undefined, 'ok'), null);
});
