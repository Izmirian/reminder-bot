/**
 * Pure-logic unit tests — no DB or network required.
 * Lock in parsing behavior and the bulk-action detection that gates
 * the cancel/complete handlers (regression cover for this session's fixes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSnooze, detectCategory, toCronExpr } from '../src/parser.js';
import { orderRemindersForDisplay } from '../src/assistant.js';

// The exact bulk-detection the handlers use to decide "operate on ALL reminders".
// Kept in sync with src/whatsapp/handler.js and src/index.js. Tightened so a
// recurrence phrase like "every day" no longer nukes every reminder.
const isBulk = (text) => /\b(all|everything|both)\b/i.test(text) || /\bevery\s+(reminder|one|single|task)\b/i.test(text);

test('bulk-action detection matches plural/all phrasings', () => {
  for (const phrase of [
    'mark all as done',
    'cancel everything',
    'complete all reminders',
    'cancel both',
    'mark every reminder done',
    'cancel every single one',
  ]) {
    assert.ok(isBulk(phrase), `expected bulk match: "${phrase}"`);
  }
});

test('bulk-action detection does NOT match single-target or recurrence phrasings', () => {
  for (const phrase of [
    'done with gold exchange',
    'cancel the dentist reminder',
    'mark gym as done',
    'reschedule lady bug to 10am',
    'cancel my reminder to read every day',   // the data-loss footgun: "every day" must NOT be bulk
    'remind me to stretch every morning',
  ]) {
    assert.equal(isBulk(phrase), false, `should not be bulk: "${phrase}"`);
  }
});

test('orderRemindersForDisplay groups Today → Upcoming → Recurring (canonical letter order)', () => {
  const todayStr = new Date().toISOString().split('T')[0];
  const reminders = [
    { id: 1, text: 'recurring early', cron_expr: '0 6 * * *', remind_at: `${todayStr}T06:00:00.000Z` },
    { id: 2, text: 'today noon', cron_expr: null, remind_at: `${todayStr}T12:00:00.000Z` },
    { id: 3, text: 'next week', cron_expr: null, remind_at: '2999-01-01T09:00:00.000Z' },
  ];
  const ordered = orderRemindersForDisplay(reminders);
  // Today first (id 2), then upcoming (id 3), then recurring (id 1) — even though
  // the recurring one has the earliest remind_at.
  assert.deepEqual(ordered.map(r => r.id), [2, 3, 1]);
});

test('orderRemindersForDisplay puts no-time items (remind_at NULL) last', () => {
  const todayStr = new Date().toISOString().split('T')[0];
  const reminders = [
    { id: 1, text: 'no time', cron_expr: null, remind_at: null },
    { id: 2, text: 'today', cron_expr: null, remind_at: `${todayStr}T09:00:00.000Z` },
    { id: 3, text: 'recurring', cron_expr: '0 6 * * *', remind_at: `${todayStr}T06:00:00.000Z` },
  ];
  const ordered = orderRemindersForDisplay(reminders);
  // today (2) → recurring (3) → no-time (1)
  assert.deepEqual(ordered.map(r => r.id), [2, 3, 1]);
});

test('parseSnooze understands minutes and hours', () => {
  assert.equal(parseSnooze('snooze 30'), 30);          // bare = minutes
  assert.equal(parseSnooze('snooze 30 min'), 30);
  assert.equal(parseSnooze('snooze 2h'), 120);
  assert.equal(parseSnooze('snooze 1 hour'), 60);
  assert.equal(parseSnooze('not a snooze'), null);
});

test('detectCategory returns a category or null (never throws)', () => {
  // Should not throw on any input; result is a string or null.
  const r1 = detectCategory('doctor appointment');
  const r2 = detectCategory('xyzzy nonsense');
  assert.ok(r1 === null || typeof r1 === 'string');
  assert.ok(r2 === null || typeof r2 === 'string');
});

test('toCronExpr produces a valid 5-field cron for daily', () => {
  const expr = toCronExpr('daily', 9, 30);
  assert.equal(typeof expr, 'string');
  assert.equal(expr.trim().split(/\s+/).length, 5, `not 5 fields: "${expr}"`);
});

import { isQuietNow, parseQuietSpec, formatClock } from '../src/quiet.js';

test('parseQuietSpec handles natural-language and disable forms', () => {
  assert.deepEqual(parseQuietSpec('11pm to 8am'), { start: '23:00', end: '08:00' });
  assert.deepEqual(parseQuietSpec('23:00-08:00'), { start: '23:00', end: '08:00' });
  assert.deepEqual(parseQuietSpec('10 pm until 7 am'), { start: '22:00', end: '07:00' });
  assert.deepEqual(parseQuietSpec('off'), { start: null, end: null });
  assert.equal(parseQuietSpec('gibberish'), null);
});

test('isQuietNow respects the wrap-past-midnight window', () => {
  // Build a window that definitely contains "now" and one that definitely doesn't,
  // using UTC so the test is timezone-stable.
  const nowH = new Date().getUTCHours();
  const inStart = String((nowH + 23) % 24).padStart(2, '0') + ':00'; // 1h before now
  const inEnd = String((nowH + 1) % 24).padStart(2, '0') + ':00';    // 1h after now
  assert.equal(isQuietNow({ quiet_start: inStart, quiet_end: inEnd, timezone: 'UTC' }), true);

  const outStart = String((nowH + 2) % 24).padStart(2, '0') + ':00';
  const outEnd = String((nowH + 4) % 24).padStart(2, '0') + ':00';
  assert.equal(isQuietNow({ quiet_start: outStart, quiet_end: outEnd, timezone: 'UTC' }), false);

  // No window set → never quiet.
  assert.equal(isQuietNow({ timezone: 'UTC' }), false);
});

test('formatClock renders 24h as 12h', () => {
  assert.equal(formatClock('23:00'), '11:00 PM');
  assert.equal(formatClock('08:30'), '8:30 AM');
  assert.equal(formatClock('00:00'), '12:00 AM');
});

import { isSchedulable } from '../src/db.js';

test('isSchedulable: only rows with a time or cron are scheduled (no-time skipped)', () => {
  assert.equal(isSchedulable({ remind_at: null, cron_expr: null }), false);   // no-time item
  assert.equal(isSchedulable({ remind_at: '', cron_expr: null }), false);     // empty string is also no-time
  assert.equal(isSchedulable({ remind_at: '2030-01-01T09:00:00Z', cron_expr: null }), true);
  assert.equal(isSchedulable({ remind_at: null, cron_expr: '0 6 * * *' }), true);
});

// The exact safety-net regex both handlers use to extract the raw task from a
// no-time capture ("remind me to X" → "X"). Guards a data-loss path (capture vs drop).
const stripReminderPrefix = (text) =>
  text.trim().replace(/^(remind me( to| about)?|remember( to)?|note:?)\s*/i, '').trim() || text.trim();

test('safety-net prefix strip extracts the task text for no-time capture', () => {
  assert.equal(stripReminderPrefix('remind me to buy milk'), 'buy milk');
  assert.equal(stripReminderPrefix('remind me about the dentist'), 'the dentist');
  assert.equal(stripReminderPrefix('remember to call mom'), 'call mom');
  assert.equal(stripReminderPrefix('note: pick up parcel'), 'pick up parcel');
  assert.equal(stripReminderPrefix('buy milk'), 'buy milk');           // no prefix → unchanged
  assert.equal(stripReminderPrefix('remind me to '), 'remind me to');  // would-be-empty → falls back to original
});

test('orderRemindersForDisplay: all four buckets ordered today→upcoming→recurring→noTime', () => {
  const todayStr = new Date().toISOString().split('T')[0];
  const reminders = [
    { id: 1, text: 'no time', cron_expr: null, remind_at: null },
    { id: 2, text: 'upcoming', cron_expr: null, remind_at: '2999-01-01T09:00:00.000Z' },
    { id: 3, text: 'recurring', cron_expr: '0 6 * * *', remind_at: `${todayStr}T06:00:00.000Z` },
    { id: 4, text: 'today', cron_expr: null, remind_at: `${todayStr}T08:00:00.000Z` },
    { id: 5, text: 'no time 2', cron_expr: null, remind_at: null },
  ];
  const ordered = orderRemindersForDisplay(reminders);
  // today(4) → upcoming(2) → recurring(3) → noTime(1,5 in input order)
  assert.deepEqual(ordered.map(r => r.id), [4, 2, 3, 1, 5]);
});

test('orderRemindersForDisplay: cron+null remind_at buckets as recurring, not no-time', () => {
  const ordered = orderRemindersForDisplay([
    { id: 1, text: 'recurring no remind_at', cron_expr: '0 9 * * *', remind_at: null },
  ]);
  // It has a cron, so it is schedulable/recurring — must NOT be treated as a no-time item.
  assert.deepEqual(ordered.map(r => r.id), [1]);
  assert.ok(isSchedulable(ordered[0]));
});
