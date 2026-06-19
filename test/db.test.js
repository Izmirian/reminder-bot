/**
 * DB smoke tests — run the query functions that have caused production
 * incidents and assert they execute without throwing.
 *
 * These ONLY run when DATABASE_URL is set (i.e. in CI against a real
 * Postgres 18 service container). Locally without DATABASE_URL they skip,
 * so `npm test` stays green on a dev machine using SQLite.
 *
 * This is the layer that catches Postgres-version-specific bugs like the
 * "COALESCE types text and timestamp with time zone cannot be matched"
 * crash (PG18 strict type coercion) that the local SQLite path never sees.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const hasDb = !!process.env.DATABASE_URL;
const TEST_CHAT = 'test-chat-0000000000';

let db;
before(async () => {
  if (!hasDb) return;
  // Importing resolves only after the top-level DB init completes.
  db = await import('../src/db.js');
});

test('initialization connected to Postgres', { skip: !hasDb }, async () => {
  // pingDb throws if the DB isn't usable.
  await db.pingDb();
});

test('markReminderFired runs (PG18 COALESCE text/timestamptz)', { skip: !hasDb }, async () => {
  // ID 0 never exists; we only care that the SQL type-checks and executes.
  await db.markReminderFired(0);
});

test('getMissedReminders runs (remind_at::timestamptz < NOW())', { skip: !hasDb }, async () => {
  const rows = await db.getMissedReminders();
  assert.ok(Array.isArray(rows));
});

test('getDueFollowups runs (follow_up_at::timestamptz <= NOW())', { skip: !hasDb }, async () => {
  const rows = await db.getDueFollowups(TEST_CHAT);
  assert.ok(Array.isArray(rows));
});

test('getActivitySummary runs (created_at/cancelled_at/completed_at windows)', { skip: !hasDb }, async () => {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const summary = await db.getActivitySummary(TEST_CHAT, since);
  assert.ok(Array.isArray(summary.added));
  assert.ok(Array.isArray(summary.completed));
  assert.ok(Array.isArray(summary.cancelled));
});

test('getWeeklyStats runs', { skip: !hasDb }, async () => {
  const stats = await db.getWeeklyStats(TEST_CHAT);
  assert.equal(typeof stats.completed, 'number');
});

test('full create→cancel→activity roundtrip stamps cancelled_at', { skip: !hasDb }, async () => {
  const id = await db.createReminder({
    chatId: TEST_CHAT,
    text: 'ci smoke test reminder',
    remindAt: new Date(Date.now() + 86400000).toISOString(),
  });
  await db.markReminderCancelled(id);
  const since = new Date(Date.now() - 60000).toISOString();
  const summary = await db.getActivitySummary(TEST_CHAT, since);
  assert.ok(summary.cancelled.some(r => r.id === id), 'cancelled reminder should appear in activity');
});

test('no-time reminder: create with NULL remind_at, appears in getNoTimeReminders', { skip: !hasDb }, async () => {
  const id = await db.createNoTimeReminder({ chatId: TEST_CHAT, text: 'ci no-time item', category: 'personal' });
  assert.ok(id, 'createNoTimeReminder should return an id');
  const noTime = await db.getNoTimeReminders(TEST_CHAT);
  const row = noTime.find(r => r.id === id);
  assert.ok(row, 'no-time reminder should appear in getNoTimeReminders');
  // Pin the columns so a future text/category/remind_at column-swap is caught (one shipped tonight).
  assert.equal(row.text, 'ci no-time item');
  assert.equal(row.category, 'personal');
  assert.equal(row.remind_at, null);
  assert.equal(Number(row.active), 1);
  // It must NOT leak into the time-based queries that would try to fire it.
  const missed = await db.getMissedReminders();
  assert.ok(!missed.some(r => r.id === id), 'no-time reminder must not appear in getMissedReminders');
  const today = await db.getTodaysReminders(TEST_CHAT, new Date().toISOString().slice(0, 10));
  assert.ok(!today.some(r => r.id === id), 'no-time reminder must not appear in getTodaysReminders');
  // But it MUST surface in getActiveReminders (list/AI context) without the ORDER BY throwing.
  const active = await db.getActiveReminders(TEST_CHAT);
  assert.ok(active.some(r => r.id === id), 'no-time reminder should appear in getActiveReminders');
  // Cleanup
  await db.markReminderCancelled(id);
});

test('promote-to-timed: updateReminderTime moves a no-time row out of getNoTimeReminders', { skip: !hasDb }, async () => {
  const id = await db.createNoTimeReminder({ chatId: TEST_CHAT, text: 'ci promote me', category: 'personal' });
  await db.updateReminderTime(id, new Date(Date.now() + 86400000).toISOString());
  const noTime = await db.getNoTimeReminders(TEST_CHAT);
  assert.ok(!noTime.some(r => r.id === id), 'promoted reminder must leave getNoTimeReminders');
  const active = await db.getActiveReminders(TEST_CHAT);
  const row = active.find(r => r.id === id);
  assert.ok(row && row.remind_at, 'promoted reminder should now have a remind_at');
  await db.markReminderCancelled(id);
});

test('getProjectTaskCounts returns a Map (grouped count, no N+1)', { skip: !hasDb }, async () => {
  const counts = await db.getProjectTaskCounts(TEST_CHAT);
  assert.ok(counts instanceof Map, 'should return a Map of project_id → count');
});

test('logCompletedReminder tolerates a null remindAt (no-time completion, no epoch pollution)', { skip: !hasDb }, async () => {
  // Must not throw; the day/hour/minute columns must be NULL, not 1970 epoch values.
  await db.logCompletedReminder({ chatId: TEST_CHAT, text: 'ci no-time completion', remindAt: null });
});
