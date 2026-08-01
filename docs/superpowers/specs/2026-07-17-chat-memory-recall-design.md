# Chat Memory + Semantic Recall — Design Spec

**Date:** 2026-07-17
**Status:** Approved (pending spec review)
**Author:** Varant + Claude
**Branch:** `feat/chat-memory-recall`

## Summary

Retain the full WhatsApp (and, as a side effect of shared code, Telegram) conversation
history for ~2 months instead of the current ~200-message window, and make old messages
usable again: on every turn, semantically search the chat's history and surface the most
relevant older messages to the AI — so "what was that thing about the factory guy?" works
naturally, weeks later, with no special command.

## Goals

- Keep chat history for **60 days** (not a message-count cap).
- Make old messages **findable by meaning**, not just keyword — vague/fuzzy references work.
- Recall is **implicit**: no new command; it just informs normal replies.
- Zero behavior change when the embeddings provider is unset/down — the bot works exactly
  as it does today, just without recall.

## Non-Goals (V1)

- An explicit "search my history" / "what do you remember about X" command (implicit RAG only).
- Backfilling embeddings for existing pre-feature history (embed going forward only).
- Cross-chat search (each chat's recall is scoped to that chat's own history).
- Replacing or touching the **`recall` intent** (Ask-my-brain / Thoughts idea graph,
  `src/thoughts-forward.js`). That is a separate system answering questions about the
  user's *captured ideas/notes* via an external service. This feature is unrelated: it
  grounds ordinary replies in the raw conversation log itself. The two are complementary,
  not overlapping — see Background.

## Background — current behavior

- `chat_history` (Postgres) stores every exchange, but `addChatMessage` hard-prunes to the
  **last 200 rows per chat** on every write (`src/db.js:924`). At normal usage that's days,
  not months — so "keep 2 months" is blocked by this cap regardless of the 30-day purge timer
  (`PURGE_CHAT_HISTORY_DAYS: 30`, `src/config.js:40`).
- Even history that *is* stored is barely used: `classifyIntent` only ever pulls the **last
  10–20 messages** into the AI's context (`src/ai.js`, adaptive `historyLimit`). Nothing
  from further back is ever considered, cap or no cap.
- A separate, unrelated system already exists for "remember things for me": the **`recall`**
  intent (`src/ai.js` intent #21) answers questions about the user's own *captured ideas/notes*
  by querying the Thoughts idea-graph service (`askThoughts`/`formatAskReply` in
  `thoughts-forward.js`). It only covers content the user explicitly captured as an idea/note/pin
  — not ordinary conversation, reminders, or chit-chat. This feature's corpus (the full raw
  chat log) is broader and orthogonal; both can coexist and both get consulted independently.

## Trigger & mechanism

**Implicit retrieval-augmented generation (RAG).** Every stored message is embedded; on each
new user message (except simple commands), the message is embedded and matched against that
chat's history; relevant hits are injected into the AI's system prompt as a distinct
"retrieved context" section — exactly the pattern already used for `activeReminders` in
`buildPrompt()`.

## Architecture / components

| Unit | File | Responsibility |
|---|---|---|
| Embeddings client | **new** `src/embeddings.js` | Thin wrapper over the Voyage API. `embedText(text) -> number[] \| null`. Returns `null` (never throws) when `VOYAGE_API_KEY` is unset or the call fails — callers treat `null` as "skip, feature inert for this call." |
| Retention change | `src/config.js`, `src/db.js` | Raise `PURGE_CHAT_HISTORY_DAYS` 30→60; replace the 200-row hard prune in `addChatMessage` with a generous safety cap (5000/chat) so the **60-day purge cron is the real retention mechanism**, not the write-time trim. |
| Storage | `chat_history` table, Postgres only | Add `embedding vector(512)` column (`pgvector`). SQLite (local dev) gets no column — embedding/retrieval silently no-op locally, matching the project's existing "Postgres-only features" pattern. |
| Write path | `addChatMessage()` in `db.js` | After inserting a row, best-effort `embedText()` the content and `UPDATE` the row's `embedding`. Never blocks or fails the surrounding chat flow — wrapped in try/catch, logged, swallowed. |
| Read path | **new** `getRelevantHistory()` in `db.js` | pgvector cosine-similarity query scoped to `chat_id`, last 60 days, excluding rows already in the recent-window the AI is about to receive. Returns top ~5 above a similarity threshold. |
| Retrieval orchestration | `classifyIntent()` in `ai.js` | Skip entirely for `isSimpleCommand` messages (same regex already gating history-fetch). Otherwise: embed the incoming message, call `getRelevantHistory()`, format hits, pass to `buildPrompt()` as a new parameter. |
| Prompt shaping | **new** `formatRetrievedContext()` in `ai.js` | Pure function: `snippets[] -> string`. Renders a clearly-labeled "Relevant past context (may or may not be related — use only if it helps):" block with dated entries, distinct from the live conversational history so the model doesn't mistake retrieved snippets for recent turns. |

## Data flow

1. User sends any message.
2. `addChatMessage` stores it (as today) **and** embeds it in the background (best-effort).
3. In `classifyIntent`, before calling the model:
   - If `isSimpleCommand` → skip retrieval (same as today's history skip).
   - Else: `embedText(userMessage)` → `getRelevantHistory(chatId, embedding, {excludeIds: recentIds, limit: 5, minSimilarity: 0.75})`.
   - Format hits via `formatRetrievedContext()`; pass into `buildPrompt(activeReminders, retrievedContext)`.
4. Model replies as normal, now grounded in both the recent-turn window (last 10–20 msgs, unchanged) **and** the retrieved older snippets (new).
5. Nightly 3am cleanup cron purges `chat_history` rows older than 60 days (existing cron, existing function, just a bigger number).

## Error handling

- `VOYAGE_API_KEY` unset → `embedText()` always returns `null` → write path stores messages with no embedding, read path always returns zero hits → feature is fully, silently inert. No code path breaks.
- Voyage API down/timeout (10s `AbortSignal.timeout`, matching existing fetch patterns) → same `null` fallback, logged once, not per-message-spammy.
- `pgvector` extension unavailable on the Postgres instance (**confirm at build time** — Railway's managed Postgres template is expected to support it, but unverified) → fallback: store the embedding as a JSON float array in a plain column and do brute-force cosine similarity in JS at read time. Trivial at this scale (thousands of rows, not millions).
- Zero hits above threshold → no "Relevant past context" section is added; prompt is identical to today's.
- Local SQLite dev → embedding column doesn't exist; write/read paths short-circuit to no-op (mirrors existing Postgres-only feature pattern, e.g. no-time reminders).

## Testing

Pure-logic unit tests (no DB/network), in the existing `test/handlers.test.js` style:

- `formatRetrievedContext(snippets)` → correct header/format for 0, 1, and multiple snippets.
- Similarity-threshold → pgvector distance conversion helper (`minSimilarity` → `maxDistance`).
- Retrieval-skip gate reuses the existing `isSimpleCommand` regex directly (no new logic to test beyond confirming the reuse).

`embedText()` itself is not unit-tested (network-dependent, like `classifyIntent`'s model
call) — verified manually against the live Voyage API (already done: confirmed `voyage-3-lite`,
512 dimensions, 200 OK). DB-level retrieval (`getRelevantHistory`) gets smoke coverage under
the existing PG18 CI path when `DATABASE_URL` is set, consistent with other DB-touching tests.

## Config / safety

- New env var: `VOYAGE_API_KEY` (already provisioned and verified working; not yet wired into Railway's deployed env — a deploy step, not part of this spec's code changes).
- `PURGE_CHAT_HISTORY_DAYS`: 30 → 60.
- New tunable in `config.js`: `CHAT_HISTORY_SAFETY_CAP: 5000` (replaces the 200 hard-trim), `CHAT_RECALL_MIN_SIMILARITY: 0.75`, `CHAT_RECALL_MAX_RESULTS: 5`.

## Privacy

Every stored message is now also sent to Voyage AI for embedding (previously: stored in
Postgres only). This applies to the user's own conversation with the bot — no third-party
content is newly involved (unlike the forward-to-capture feature, which forwards other
people's messages). Worth a one-line mention in user-facing docs alongside the existing
Anthropic-API disclosure.

## Scope / YAGNI (V1)

- Embed going forward only; no backfill script for pre-feature history.
- Implicit recall only; no explicit recall command/intent.
- Single embedding call per message; no batching.
- `voyage-3-lite` (512-dim, cheapest tier) — sufficient quality for personal-scale recall; can upgrade to `voyage-3` later if recall quality proves insufficient in practice.
- No cross-chat search — WhatsApp and Telegram chat histories are separate `chat_id`s already; recall stays scoped per chat, matching how everything else in this codebase is scoped.

## Rough build sequence

1. `pgvector` extension + `embedding vector(512)` column + HNSW index in Postgres init (`db.js`); confirm `CREATE EXTENSION vector` succeeds on Railway — fall back to JSON-array + brute-force cosine if not.
2. `src/embeddings.js`: `embedText()` wrapper, `null`-safe, timeout-guarded.
3. `db.js`: wire `embedText()` into `addChatMessage` (write path); add `getRelevantHistory()` (read path); raise the safety-cap prune from 200→5000; bump `PURGE_CHAT_HISTORY_DAYS` to 60.
4. `ai.js`: `formatRetrievedContext()` (pure, unit-tested) + retrieval orchestration in `classifyIntent`, gated by the existing `isSimpleCommand` check; extend `buildPrompt()` to accept and render the retrieved-context block.
5. Set `VOYAGE_API_KEY` on Railway; verify end-to-end (ask about something from >20 messages / several days back, confirm it surfaces).
