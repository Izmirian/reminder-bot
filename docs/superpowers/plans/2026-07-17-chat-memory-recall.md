# Chat Memory + Semantic Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain WhatsApp/Telegram chat history for 60 days (up from an effective ~200-message cap) and make old messages findable by meaning — embed every message via Voyage AI, and on each turn inject the most relevant older messages into the AI's context automatically.

**Architecture:** A new `src/embeddings.js` wraps the Voyage API (`embedText`, null-safe, never throws). `db.js` gets a `pgvector` column on `chat_history`, embeds messages on write (fire-and-forget), and a `getRelevantHistory()` similarity-search read path. `ai.js` calls that read path before every non-trivial `classifyIntent` call and injects results into the system prompt via a new pure `formatRetrievedContext()` — the same pattern already used for `activeReminders`.

**Tech Stack:** Node 20 ES modules, `pg` (Postgres client, already a dependency), Voyage AI REST API via native `fetch` (no new npm dependency), `pgvector` Postgres extension.

## Global Constraints

- `VOYAGE_API_KEY` unset or Voyage unreachable → the entire feature is silently inert (no embeddings stored, no retrieval, zero behavior change). Never throw from `embeddings.js`.
- Local SQLite dev has no `chat_history.embedding` column at all — write/read paths only run when `isPostgres` is true; this matches the project's existing "Postgres-only features" pattern (no-time reminders, quiet hours, etc.).
- Retrieval failures must never trip `ai.js`'s Anthropic-specific `aiAvailable`/cooldown logic — they get their own inner `try/catch`, separate from the outer one that gates Anthropic failures.
- No new npm dependencies — match the codebase's existing pattern of calling REST APIs via native `fetch` (see `src/whatsapp/api.js`).
- `pgvector` availability on Railway's Postgres is unverified going in — Task 2's DB-gated tests run against `postgres:18` in CI on every push, which is the concrete verification point.

---

### Task 1: Voyage embeddings client

**Files:**
- Create: `src/embeddings.js`
- Test: `test/embeddings.test.js`

**Interfaces:**
- Produces: `embedText(text: string) => Promise<number[] | null>` — 512-dim vector on success; `null` on missing key, empty text, timeout, or any API error. Never throws.

- [ ] **Step 1: Write the failing tests**

Create `test/embeddings.test.js`:

```js
/**
 * Voyage embeddings client tests.
 * The live-API test only runs when VOYAGE_API_KEY is set (mirrors the
 * DATABASE_URL-gated pattern in test/db.test.js) — npm test stays fast/free
 * by default, with a real integration check available when the key is present.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedText } from '../src/embeddings.js';

const hasVoyageKey = !!process.env.VOYAGE_API_KEY;

test('embedText returns null when VOYAGE_API_KEY is unset', async () => {
  const saved = process.env.VOYAGE_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  try {
    assert.equal(await embedText('hello world'), null);
  } finally {
    if (saved !== undefined) process.env.VOYAGE_API_KEY = saved;
  }
});

test('embedText returns null for empty text (fast path, no network)', async () => {
  assert.equal(await embedText(''), null);
});

test('embedText returns a 512-dim vector for real text (live Voyage call)', { skip: !hasVoyageKey }, async () => {
  const result = await embedText('The quick brown fox jumps over the lazy dog.');
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 512);
  assert.equal(typeof result[0], 'number');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/embeddings.test.js`
Expected: FAIL — `Cannot find module '../src/embeddings.js'`

- [ ] **Step 3: Write the implementation**

Create `src/embeddings.js`:

```js
/**
 * Voyage AI embeddings client — used for semantic chat-history recall.
 * Returns null (never throws) when unconfigured or on any failure, so
 * callers can treat a missing embedding as "feature inert for this call."
 */
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3-lite'; // 512-dim, cheapest tier — sufficient for personal-scale recall
const TIMEOUT_MS = 10000;

export async function embedText(text) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || !text) return null;
  try {
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: [text], model: MODEL }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[Embeddings] Voyage API error: ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data.data?.[0]?.embedding || null;
  } catch (e) {
    console.error('[Embeddings] embedText failed:', e.message);
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/embeddings.test.js`
Expected: 2 pass, 1 skip (no `VOYAGE_API_KEY` locally) — or 3 pass if the key is sourced from `.env`.

- [ ] **Step 5: Commit**

```bash
git add src/embeddings.js test/embeddings.test.js
git commit -m "Add Voyage embeddings client (embedText, null-safe)"
```

---

### Task 2: DB schema — pgvector column, 60-day retention, write path

**Files:**
- Modify: `src/config.js:12-14,40`
- Modify: `src/db.js` (top import, `initPostgres()` migration block, `purgeOldChatHistory()`, `addChatMessage()`)
- Test: `test/db.test.js`

**Interfaces:**
- Consumes: `embedText` from `src/embeddings.js` (Task 1).
- Produces: `addChatMessage(chatId, role, content) => Promise<number>` (now returns the inserted row's `id` — previously returned nothing; the one existing caller in `ai.js` already discards the return value, so this is additive). `storeEmbedding(id: number, embedding: number[]) => Promise<void>`. `embedAndStoreMessage(id: number, content: string) => Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/db.test.js` (after the last existing test):

```js

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `DATABASE_URL=<your-postgres-url> node --test test/db.test.js`
Expected: FAIL — `db.storeEmbedding is not a function` (and `embedAndStoreMessage` likewise). If you don't have a local Postgres, skip straight to Step 3 and rely on CI (`postgres:18`) to verify — the existing DB-test suite already follows this skip-locally/verify-in-CI convention.

- [ ] **Step 3: Update `src/config.js`**

Replace lines 11-14:

```js
  // Chat history
  CHAT_HISTORY_DB_LIMIT: 200,        // Max messages stored in DB per chat
  CHAT_HISTORY_AI_CONTEXT: 20,       // Max messages sent to AI (default, adaptive overrides)
  CHAT_MESSAGE_MAX_CHARS: 2000,      // Max chars per stored message
```

with:

```js
  // Chat history
  CHAT_HISTORY_SAFETY_CAP: 5000,     // Hard cap per chat — real retention is the 60-day purge cron (PURGE_CHAT_HISTORY_DAYS below)
  CHAT_HISTORY_AI_CONTEXT: 20,       // Max messages sent to AI (default, adaptive overrides)
  CHAT_MESSAGE_MAX_CHARS: 2000,      // Max chars per stored message
  CHAT_RECALL_MIN_SIMILARITY: 0.75,  // Min cosine similarity for a semantic-recall match
  CHAT_RECALL_MAX_RESULTS: 5,        // Max retrieved snippets injected into the AI prompt per turn
  CHAT_RECALL_MIN_AGE_HOURS: 1,      // Exclude very-recent messages (already covered by the live history window)
```

Replace line 40 (now shifted — search for it):

```js
  PURGE_CHAT_HISTORY_DAYS: 30,       // Purge chat history after N days
```

with:

```js
  PURGE_CHAT_HISTORY_DAYS: 60,       // Purge chat history after N days (was 30 — extended so semantic recall has real range)
```

- [ ] **Step 4: Import `CONFIG` into `src/db.js`**

At the top of `src/db.js`, change:

```js
import pg from 'pg';
```

to:

```js
import pg from 'pg';
import { CONFIG } from './config.js';
```

- [ ] **Step 5: Add the pgvector migration to `initPostgres()`**

In `src/db.js`, find the existing migration block (ends with `ALTER TABLE reminders ALTER COLUMN remind_at DROP NOT NULL` followed by `} catch (e) { console.error('[DB] Migration:', e.message); }`). Add the new lines immediately before the `} catch`:

```js
    // No-time reminders: remind_at NULL = a captured item with no schedule yet.
    await pool.query(`ALTER TABLE reminders ALTER COLUMN remind_at DROP NOT NULL`);
    // Semantic chat-memory recall — pgvector extension + embedding column + ANN index.
    // If the extension isn't available on this Postgres instance, this throws and is
    // caught below; the feature then stays silently disabled (write/read paths already
    // treat a missing column as "return null / []" — see Task 3/4).
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await pool.query(`ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS embedding vector(512)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_history_embedding ON chat_history USING hnsw (embedding vector_cosine_ops)`);
  } catch (e) { console.error('[DB] Migration:', e.message); }
```

(Only the last four lines — `// Semantic chat-memory...` through the three `await pool.query` calls — are new; the `ALTER TABLE reminders...` line and the closing `} catch` already exist and are shown for placement context.)

- [ ] **Step 6: Update `purgeOldChatHistory()`**

In `src/db.js`, replace:

```js
// Delete chat history older than 30 days
export async function purgeOldChatHistory() {
  const result = await run(
    "DELETE FROM chat_history WHERE created_at < NOW() - INTERVAL '30 days'"
  );
  return result.changes || 0;
}
```

with:

```js
// Delete chat history older than PURGE_CHAT_HISTORY_DAYS (60) — the real retention
// mechanism for chat memory; addChatMessage's own prune is just a safety cap.
export async function purgeOldChatHistory() {
  const result = await run(
    `DELETE FROM chat_history WHERE created_at < NOW() - INTERVAL '${CONFIG.PURGE_CHAT_HISTORY_DAYS} days'`
  );
  return result.changes || 0;
}
```

- [ ] **Step 7: Update `addChatMessage()` and add `storeEmbedding()` / `embedAndStoreMessage()`**

In `src/db.js`, replace:

```js
export async function addChatMessage(chatId, role, content) {
  await insert('INSERT INTO chat_history (chat_id, role, content) VALUES (?, ?, ?)',
    [chatId, role, content.substring(0, 2000)]); // Cap at 2000 chars per message
  // Prune old messages — keep last 200 per chat (100 exchanges)
  await run(
    `DELETE FROM chat_history WHERE chat_id = ? AND id NOT IN (SELECT id FROM chat_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT 200)`,
    [chatId, chatId]
  );
}
```

with:

```js
export async function addChatMessage(chatId, role, content) {
  const trimmed = content.substring(0, 2000); // Cap at 2000 chars per message
  const id = await insert('INSERT INTO chat_history (chat_id, role, content) VALUES (?, ?, ?)',
    [chatId, role, trimmed]);
  // Safety-cap prune — the real retention mechanism is the 60-day purge cron
  // (purgeOldChatHistory). This just bounds worst-case table growth.
  await run(
    `DELETE FROM chat_history WHERE chat_id = ? AND id NOT IN (SELECT id FROM chat_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT ${CONFIG.CHAT_HISTORY_SAFETY_CAP})`,
    [chatId, chatId]
  );
  // Best-effort embed — fire-and-forget so a slow/failed Voyage call never
  // blocks or fails the surrounding chat flow.
  if (isPostgres && id) {
    embedAndStoreMessage(id, trimmed).catch((e) => console.error('[DB] Embed-write failed:', e.message));
  }
  return id;
}

// Write an already-computed embedding to a chat_history row. Split out from
// embedAndStoreMessage so schema/cast behavior is testable with a synthetic
// vector, independent of a live Voyage call.
export async function storeEmbedding(id, embedding) {
  const vectorLiteral = `[${embedding.join(',')}]`;
  await run('UPDATE chat_history SET embedding = ?::vector WHERE id = ?', [vectorLiteral, id]);
}

// Embed a message's content via Voyage and store it. Returns false (never
// throws) if embeddings are unconfigured/unavailable — callers treat that as
// "this row just has no embedding," not an error.
export async function embedAndStoreMessage(id, content) {
  const embedding = await embedText(content);
  if (!embedding) return false;
  await storeEmbedding(id, embedding);
  return true;
}
```

- [ ] **Step 8: Import `embedText` into `src/db.js`**

Change the Task 1 import line at the top of `src/db.js` from Step 4 to also bring in `embedText`:

```js
import pg from 'pg';
import { CONFIG } from './config.js';
import { embedText } from './embeddings.js';
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `DATABASE_URL=<your-postgres-url> node --test test/db.test.js`
Expected: All pass (the two `hasDb`-gated tests from Step 1; the Voyage-gated one passes if `VOYAGE_API_KEY` is also set, otherwise skips). Without a local Postgres, this task's real verification is the next CI run (Step 10).

- [ ] **Step 10: Commit**

```bash
git add src/config.js src/db.js test/db.test.js
git commit -m "Add pgvector schema, 60-day retention, embed-on-write for chat_history"
```

Push this branch (or open/update the PR) before moving to Task 3 so CI's `postgres:18` service container verifies the `pgvector` extension and schema migration actually work — this is the concrete resolution of the spec's "confirm at build time" flag. If CI's `test` job fails on this commit specifically because `CREATE EXTENSION vector` errors, stop and report back — that's an architecture question (is `pgvector` available on the target Postgres at all), not something to patch around in this plan.

---

### Task 3: Semantic retrieval read path

**Files:**
- Modify: `src/db.js` (add `similarityToDistance`, `getRelevantHistory`)
- Test: `test/db.test.js`

**Interfaces:**
- Consumes: `CONFIG.CHAT_RECALL_MIN_SIMILARITY`, `CONFIG.CHAT_RECALL_MAX_RESULTS`, `CONFIG.CHAT_RECALL_MIN_AGE_HOURS`, `CONFIG.PURGE_CHAT_HISTORY_DAYS` (Task 2). `storeEmbedding`, `addChatMessage` (Task 2).
- Produces: `similarityToDistance(minSimilarity: number) => number` (pure). `getRelevantHistory(chatId: string, embedding: number[] | null, opts?: {minSimilarity?, limit?, minAgeHours?}) => Promise<Array<{role, content, created_at}>>` — empty array on no matches, no embedding, or non-Postgres.

- [ ] **Step 1: Write the failing tests**

Append to `test/db.test.js`:

```js

// --- Chat-memory: semantic retrieval read path ---

test('getRelevantHistory returns [] when embedding is null (feature inert)', { skip: !hasDb }, async () => {
  const results = await db.getRelevantHistory(TEST_CHAT, null);
  assert.deepEqual(results, []);
});

test('getRelevantHistory: exact-match vector ranks above an orthogonal vector', { skip: !hasDb }, async () => {
  const chatId = TEST_CHAT + '-similarity';
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
  const chatId = TEST_CHAT + '-recency';
  const vec = Array(512).fill(0); vec[0] = 1;
  const id = await db.addChatMessage(chatId, 'user', 'just said this a second ago');
  await db.storeEmbedding(id, vec);
  // Default minAgeHours (CONFIG.CHAT_RECALL_MIN_AGE_HOURS = 1) excludes a row this fresh.
  const results = await db.getRelevantHistory(chatId, vec);
  assert.equal(results.length, 0);
});

test('similarityToDistance converts min-similarity to a pgvector max-distance', () => {
  assert.equal(db.similarityToDistance(0.75), 0.25);
  assert.equal(db.similarityToDistance(1), 0);
  assert.equal(db.similarityToDistance(0), 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `DATABASE_URL=<your-postgres-url> node --test test/db.test.js`
Expected: FAIL — `db.getRelevantHistory is not a function` / `db.similarityToDistance is not a function`.

- [ ] **Step 3: Implement `similarityToDistance` and `getRelevantHistory`**

In `src/db.js`, add after `embedAndStoreMessage` (from Task 2):

```js
// Pure — pgvector's <=> operator (with vector_cosine_ops) returns cosine
// DISTANCE (1 - similarity), so a similarity threshold must be inverted
// before use in a WHERE clause. Exported for direct unit testing.
export function similarityToDistance(minSimilarity) {
  return 1 - minSimilarity;
}

// Semantic search over a chat's older history. Returns [] (never throws) when
// embeddings are unavailable/unconfigured/non-Postgres — callers treat that as
// "no relevant context found," identical to a genuine zero-match result.
export async function getRelevantHistory(chatId, embedding, opts = {}) {
  if (!isPostgres || !embedding) return [];
  const {
    minSimilarity = CONFIG.CHAT_RECALL_MIN_SIMILARITY,
    limit = CONFIG.CHAT_RECALL_MAX_RESULTS,
    minAgeHours = CONFIG.CHAT_RECALL_MIN_AGE_HOURS,
  } = opts;
  const maxDistance = similarityToDistance(minSimilarity);
  const vectorLiteral = `[${embedding.join(',')}]`;
  try {
    const rows = (await query(
      `SELECT role, content, created_at FROM chat_history
       WHERE chat_id = ? AND embedding IS NOT NULL
         AND created_at > NOW() - INTERVAL '${CONFIG.PURGE_CHAT_HISTORY_DAYS} days'
         AND created_at < NOW() - INTERVAL '${minAgeHours} hours'
         AND (embedding <=> ?::vector) <= ?
       ORDER BY embedding <=> ?::vector
       LIMIT ?`,
      [chatId, vectorLiteral, maxDistance, vectorLiteral, limit]
    )).rows;
    return rows;
  } catch (e) {
    console.error('[DB] getRelevantHistory failed:', e.message);
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `DATABASE_URL=<your-postgres-url> node --test test/db.test.js`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/db.test.js
git commit -m "Add semantic retrieval read path (getRelevantHistory, similarityToDistance)"
```

---

### Task 4: Wire retrieval into AI classification

**Files:**
- Modify: `src/ai.js` (top import, `buildPrompt()`, `classifyIntent()`)
- Test: `test/handlers.test.js`

**Interfaces:**
- Consumes: `embedText` (Task 1), `getRelevantHistory` (Task 3).
- Produces: `formatRetrievedContext(snippets: Array<{role, content, created_at}> | null | undefined) => string` (pure, exported).

- [ ] **Step 1: Write the failing tests**

Append to `test/handlers.test.js`:

```js

import { formatRetrievedContext } from '../src/ai.js';

test('formatRetrievedContext returns empty string for no snippets', () => {
  assert.equal(formatRetrievedContext([]), '');
  assert.equal(formatRetrievedContext(null), '');
  assert.equal(formatRetrievedContext(undefined), '');
});

test('formatRetrievedContext renders dated, role-labeled snippets', () => {
  const snippets = [
    { role: 'user', content: 'my wifi password is hunter2', created_at: '2026-05-01T10:00:00.000Z' },
    { role: 'assistant', content: 'Got it, saved.', created_at: '2026-05-01T10:00:05.000Z' },
  ];
  const block = formatRetrievedContext(snippets);
  assert.ok(block.includes('my wifi password is hunter2'));
  assert.ok(block.includes('user:'));
  assert.ok(block.includes('assistant:'));
  assert.ok(block.includes('Relevant past context'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/handlers.test.js`
Expected: FAIL — `formatRetrievedContext is not a function` (import error from `ai.js` not exporting it).

- [ ] **Step 3: Add `formatRetrievedContext` and extend `buildPrompt`**

In `src/ai.js`, change:

```js
function buildPrompt(activeReminders) {
```

to:

```js
// Pure — formats retrieved older messages into a labeled system-prompt
// section, kept visually distinct from the live conversational history so
// the model treats these as background context, not recent turns.
export function formatRetrievedContext(snippets) {
  if (!snippets || snippets.length === 0) return '';
  let block = '\n\nRelevant past context (from earlier conversation — may or may not be related; use only if it helps answer the current message):\n';
  for (const s of snippets) {
    const date = new Date(s.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    block += `- [${date}] ${s.role}: ${s.content}\n`;
  }
  return block;
}

function buildPrompt(activeReminders, retrievedContext = '') {
```

Then find the end of `buildPrompt`'s template literal:

```js
Category: health (medicine, doctor, gym), work (meeting, email, deadline), personal (groceries, buy, clean)
${remindersContext}

Return ONLY valid JSON. No markdown, no code fences, no explanation.`;
}
```

and change it to:

```js
Category: health (medicine, doctor, gym), work (meeting, email, deadline), personal (groceries, buy, clean)
${remindersContext}${retrievedContext}

Return ONLY valid JSON. No markdown, no code fences, no explanation.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/handlers.test.js`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/ai.js test/handlers.test.js
git commit -m "Add formatRetrievedContext and thread it through buildPrompt"
```

- [ ] **Step 6: Wire retrieval into `classifyIntent`**

In `src/ai.js`, update the import line:

```js
import { addChatMessage, getChatHistory as dbGetChatHistory } from './db.js';
```

to:

```js
import { addChatMessage, getChatHistory as dbGetChatHistory, getRelevantHistory } from './db.js';
import { embedText } from './embeddings.js';
```

Then, inside `classifyIntent`, find:

```js
    const historyLimit = isSimpleCommand ? 0 : needsFullContext ? 20 : 10;
    const history = (chatId && historyLimit > 0) ? await dbGetChatHistory(chatId, historyLimit) : [];

    const messages = [
```

and change it to:

```js
    const historyLimit = isSimpleCommand ? 0 : needsFullContext ? 20 : 10;
    const history = (chatId && historyLimit > 0) ? await dbGetChatHistory(chatId, historyLimit) : [];

    // Semantic recall — surface older, relevant messages beyond the recent
    // window. Skipped for simple commands (same gate as history) since they
    // never need context. Failures here must NOT trip the Anthropic-specific
    // cooldown below (outer catch) — hence the separate inner try/catch.
    let retrievedContext = '';
    if (chatId && !isSimpleCommand) {
      try {
        const queryEmbedding = await embedText(userMessage);
        if (queryEmbedding) {
          const snippets = await getRelevantHistory(chatId, queryEmbedding);
          retrievedContext = formatRetrievedContext(snippets);
        }
      } catch (e) { console.error('[AI] Retrieval failed:', e.message); }
    }

    const messages = [
```

Then update both `buildPrompt` call sites. First:

```js
      system: buildPrompt(activeReminders),
      messages,
    });
```

(the primary call, inside `api.messages.create({...})`) becomes:

```js
      system: buildPrompt(activeReminders, retrievedContext),
      messages,
    });
```

Second, the Sonnet-retry call:

```js
        const retryRes = await api.messages.create({ model: 'claude-sonnet-5', max_tokens: 800, system: buildPrompt(activeReminders), messages });
```

becomes:

```js
        const retryRes = await api.messages.create({ model: 'claude-sonnet-5', max_tokens: 800, system: buildPrompt(activeReminders, retrievedContext), messages });
```

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: All pass (no new failures; this step has no new unit tests of its own — the orchestration reuses the already-tested `isSimpleCommand` gate, `formatRetrievedContext`, and `getRelevantHistory`, per the spec's testing section).

- [ ] **Step 8: Commit**

```bash
git add src/ai.js
git commit -m "Wire semantic recall into classifyIntent (implicit RAG)"
```

---

### Task 5: Deploy and verify end-to-end

**Files:** None (operational/deployment task — no code changes).

- [ ] **Step 1: Set `VOYAGE_API_KEY` on Railway**

In Railway's dashboard, open the bot's service → Variables, and add `VOYAGE_API_KEY` with the value already verified working locally (stored in `.env` and NoxKey `general/general/VOYAGE_API_KEY`). This triggers a redeploy.

- [ ] **Step 2: Confirm the migration succeeded on the real Railway Postgres**

After the redeploy, check Railway's deploy logs for a `[DB] Migration:` error line. If present, `CREATE EXTENSION IF NOT EXISTS vector` failed on Railway's instance specifically (even though CI's `postgres:18` succeeded) — stop and report back; this is an infrastructure question (pgvector availability on the specific managed instance), not something to patch around.

- [ ] **Step 3: Manual end-to-end verification**

On WhatsApp (or Telegram), send a distinctive message (e.g. "my dentist's name is Dr. Farouk"). Wait at least `CHAT_RECALL_MIN_AGE_HOURS` (1 hour) — or temporarily lower `CHAT_RECALL_MIN_AGE_HOURS` in `config.js` to `0` for a faster manual check, then revert. Then send an unrelated message referencing it vaguely ("who's my dentist again?") and confirm the reply surfaces the earlier fact — proving the full pipeline (embed-on-write → retrieval → prompt injection → reply) works live.

- [ ] **Step 4: Update `CLAUDE.md`**

Add `VOYAGE_API_KEY` to the Environment Variables list, and a one-line mention under a relevant section (e.g. near "Conversation History") noting: retention is now 60 days, and older messages are surfaced via semantic search when relevant — implicit, no command needed.

## Plan Self-Review

**Spec coverage:**
- 60-day retention → Task 2 (config + `purgeOldChatHistory`).
- Embed on write, best-effort/non-blocking → Task 2 (`addChatMessage` fire-and-forget).
- `pgvector` storage, confirm-at-build-time → Task 2 (schema migration + CI as the verification point) + Task 5 Step 2 (Railway-specific confirmation).
- Semantic read path, threshold, recency exclusion → Task 3.
- Implicit injection into `classifyIntent`/`buildPrompt`, skip for simple commands → Task 4.
- `VOYAGE_API_KEY` unset → fully inert → Task 1 (`embedText` returns `null`) propagates through every downstream consumer.
- Testing philosophy (pure functions unit-tested, DB-gated smoke tests, live-API calls not required for `npm test`) → followed throughout; deviates from the spec's original "live semantic search" test sketch in favor of synthetic-vector tests for CI coverage without a Voyage secret — a strict improvement (see Task 3 note below).
- Privacy note, `CLAUDE.md` update → Task 5 Step 4.

**Deviation from spec worth flagging:** the spec's Testing section didn't specify *how* `getRelevantHistory` gets DB-level coverage. This plan uses hand-crafted orthogonal vectors (Task 3) instead of live Voyage embeddings, so the core similarity/threshold/recency logic is verified automatically in CI (`postgres:18`, no secret required) rather than only in an optional, key-gated manual test. The `pgvector`-availability question the spec flagged as "confirm at build time" is thus resolved automatically on every CI run from Task 2 onward, not deferred to manual verification.

**Placeholder scan:** none found — every step has complete, runnable code.

**Type consistency:** `addChatMessage` return type (`number`, the row id) is introduced in Task 2 and not relied upon by any new code in later tasks (Task 2's own `embedAndStoreMessage` fire-and-forget call is the only consumer). `getRelevantHistory`'s return shape (`{role, content, created_at}[]`) is defined in Task 3 and consumed identically by `formatRetrievedContext` in Task 4. `similarityToDistance`, `storeEmbedding`, `embedAndStoreMessage`, `embedText` names are used consistently across all tasks that reference them.
