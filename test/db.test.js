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

// --- Chat-memory: pgvector schema + write path ---

test('chat_history embedding column accepts a synthetic 512-dim vector (pgvector schema check)', { skip: !hasDb }, async () => {
  const chatId = TEST_CHAT + '-vector-write';
  const vec = Array(512).fill(0); vec[0] = 1;
  const id = await db.addChatMessage(chatId, 'user', 'pgvector schema probe');
  assert.equal(typeof id, 'number');
  await db.storeEmbedding(id, vec); // throws if the extension/column/cast don't work
});

test('addChatMessage returns the new row id', { skip: !hasDb }, async () => {
  const id = await db.addChatMessage(TEST_CHAT + '-id-check', 'user', 'id check');
  assert.equal(typeof id, 'number');
  assert.ok(id > 0);
});

const hasVoyageKey = !!process.env.VOYAGE_API_KEY;

test('embedAndStoreMessage: end-to-end with a real Voyage embedding', { skip: !hasDb || !hasVoyageKey }, async () => {
  const chatId = TEST_CHAT + '-live-embed';
  const text = 'I love hiking in the mountains every weekend';
  const id = await db.addChatMessage(chatId, 'user', text);
  const ok = await db.embedAndStoreMessage(id, text);
  assert.equal(ok, true);
});

// --- Chat-memory: semantic retrieval read path ---

test('getRelevantHistory returns [] when embedding is null (feature inert)', { skip: !hasDb }, async () => {
  const results = await db.getRelevantHistory(TEST_CHAT, null);
  assert.deepEqual(results, []);
});

test('getRelevantHistory: exact-match vector ranks above an orthogonal vector', { skip: !hasDb }, async () => {
  const chatId = TEST_CHAT + '-similarity-' + Date.now();
  const dims = 512;
  const vecA = Array(dims).fill(0); vecA[0] = 1;   // unit vector along dim 0
  const vecB = Array(dims).fill(0); vecB[1] = 1;   // orthogonal to A — cosine similarity 0

  const idA = await db.addChatMessage(chatId, 'user', 'message A — should match');
  await db.storeEmbedding(idA, vecA);
  const idB = await db.addChatMessage(chatId, 'user', 'message B — unrelated');
  await db.storeEmbedding(idB, vecB);

  // Query with A's own vector: distance to A is 0 (similarity 1, well within the
  // default 0.75 threshold); distance to B is 1 (similarity 0, filtered out).
  const results = await db.getRelevantHistory(chatId, vecA, { minAgeHours: 0 });
  assert.equal(results.length, 1);
  assert.ok(results[0].content.includes('message A'));
});

test('getRelevantHistory respects minAgeHours (excludes very recent rows by default)', { skip: !hasDb }, async () => {
  const chatId = TEST_CHAT + '-recency-' + Date.now();
  const vec = Array(512).fill(0); vec[0] = 1;
  const id = await db.addChatMessage(chatId, 'user', 'just said this a second ago');
  await db.storeEmbedding(id, vec);
  // Default minAgeHours (CONFIG.CHAT_RECALL_MIN_AGE_HOURS = 1) excludes a row this fresh.
  const results = await db.getRelevantHistory(chatId, vec);
  assert.equal(results.length, 0);
});

// Pure function — no DB access — but still gated on hasDb because `db` above is only
// populated by the conditional dynamic import in before(); ungated, this throws
// "Cannot read properties of undefined" locally instead of skipping cleanly.
test('similarityToDistance converts min-similarity to a pgvector max-distance', { skip: !hasDb }, () => {
  assert.equal(db.similarityToDistance(0.75), 0.25);
  assert.equal(db.similarityToDistance(1), 0);
  assert.equal(db.similarityToDistance(0), 1);
});
