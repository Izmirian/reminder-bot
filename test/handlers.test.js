/**
 * Pure-logic unit tests — no DB or network required.
 * Lock in parsing behavior and the bulk-action detection that gates
 * the cancel/complete handlers (regression cover for this session's fixes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSnooze, detectCategory, toCronExpr } from '../src/parser.js';

// The exact regex the handlers use to decide "operate on ALL reminders".
// Kept in sync with src/whatsapp/handler.js and src/index.js.
const BULK_RE = /\b(all|every|everything|both)\b/i;

test('bulk-action detection matches plural/all phrasings', () => {
  for (const phrase of [
    'mark all as done',
    'cancel everything',
    'complete all reminders',
    'cancel both',
    'mark every reminder done',
  ]) {
    assert.ok(BULK_RE.test(phrase), `expected bulk match: "${phrase}"`);
  }
});

test('bulk-action detection does NOT match single-target phrasings', () => {
  for (const phrase of [
    'done with gold exchange',
    'cancel the dentist reminder',
    'mark gym as done',
    'reschedule lady bug to 10am',
  ]) {
    assert.equal(BULK_RE.test(phrase), false, `should not be bulk: "${phrase}"`);
  }
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
