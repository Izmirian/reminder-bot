# Personal Assistant Bot

A dual-platform (Telegram + WhatsApp) AI-powered personal assistant deployed on Railway with Postgres.

## Architecture

- **Runtime:** Node.js ES modules (`"type": "module"`, requires Node >=20)
- **AI:** Claude Sonnet + Haiku via `@anthropic-ai/sdk` — smart model selection, 18 intents, conversation history, vision API
- **Database:** Postgres (Railway) with SQLite fallback (local dev). All DB functions are async. Connection retry with backoff on startup.
- **Telegram:** `node-telegram-bot-api` with long polling + error handlers
- **WhatsApp:** Express webhook server for Meta Cloud API v22.0 with signature verification + message deduplication
- **Scheduling:** `node-cron` for recurring jobs, `setTimeout` for one-off reminders
- **Deployment:** Railway auto-deploy from GitHub (`main` branch), `Procfile: web: node start.js`

## Key Files

| File | Purpose |
|------|---------|
| `start.js` | Entry point — crash handlers, env warnings, imports both bots, graceful shutdown |
| `src/ai.js` | Claude AI intent classifier (18 intents), smart model selection (Haiku/Sonnet), adaptive history, rate limiting, conversation context |
| `src/db.js` | All database operations — Postgres/SQLite dual-mode, 16 tables, 13 indexes, connection retry, pool config |
| `src/config.js` | Centralized constants — timeouts, limits, retention periods, rate limits |
| `src/assistant.js` | Shared handlers for lists, contacts, journal, memory, expenses, timers, summarizer, dashboard, projects, pins, follow-ups, research, email drafts, undo, conflict detection |
| `src/analyze.js` | Document/image analysis using Claude Vision API (images + PDFs) |
| `src/scheduler.js` | Telegram reminder scheduler, daily digest, birthday checks, cleanup crons, idle check-in, EOD recap, week planning, follow-up alerts |
| `src/index.js` | Telegram bot — message handler, callback queries, all 18 intent routing, photo/document/forward handling |
| `src/whatsapp/handler.js` | WhatsApp message handler — mirrors Telegram with all 18 intent routing, photo/document analysis |
| `src/whatsapp/webhook.js` | Express server — Meta webhook with HMAC signature verification, message deduplication, Google OAuth routes, `/` liveness + `GET /health` (db ping + Thoughts reachability + forward stats, consumed by the Thoughts status page) |
| `src/whatsapp/scheduler.js` | WhatsApp reminder scheduler, digest, birthday checks, idle check-in, EOD recap, week planning, follow-up alerts |
| `src/whatsapp/api.js` | WhatsApp Cloud API client — fetchWithRetry (exponential backoff), send text/buttons/images, mark read, upload/download media (20MB cap) |
| `src/google-calendar.js` | Google Calendar OAuth2, event CRUD, two-way sync, transient retry on 5xx |
| `src/url-monitor.js` | URL change/price monitoring with content hashing |
| `src/monitor.js` | Reliability monitoring — external heartbeat (HEALTHCHECK_URL) + internal DB self-check that alerts owner via WhatsApp |
| `src/quiet.js` | Quiet hours — `isQuietNow`/`quietRemainingMs`/`parseQuietSpec`; non-urgent reminders held during the window, deferred via `fireReminder` gate in both schedulers |
| `src/parser.js` | chrono-node fallback date parser with `looksLikeReminder()` gate |
| `src/commands.js` | Telegram slash command handlers |
| `src/context.js` | Reminder fire message builder (priority-aware) |
| `src/conversation.js` | Fallback conversation handler when AI unavailable |
| `src/patterns.js` | Recurring pattern detection via Jaccard similarity |

## Database Tables (16)

| Table | Purpose |
|-------|---------|
| `reminders` | Core — 20+ columns including priority, media, shared_with, google_event_id, project_id |
| `settings` | Per-user — timezone, digest, location, google_tokens, quiet_start/quiet_end |
| `completed_reminders` | Completion log with day/hour/minute for pattern detection |
| `streaks` | Recurring reminder completion streaks |
| `url_monitors` | Watched URLs with content hashes and prices |
| `lists` | Quick lists (grocery, shopping, todo) with JSONB items |
| `contacts` | People notes with birthday tracking (appends, not overwrites) |
| `journal` | Daily journal entries with mood |
| `memory` | Conversation facts the bot remembers |
| `expenses` | Spending tracker with categories |
| `documents` | Stored files/PDFs with binary data |
| `chat_history` | Persisted conversation history, 60-day retention, `pgvector` embeddings for semantic recall |
| `projects` | Task grouping by project |
| `pins` | Pinned important messages |
| `followups` | People/things you're waiting on with due dates |
| `action_log` | Universal undo — last 20 actions per chat |

## AI Intent System (18 intents)

Smart model selection: Haiku for simple intents, Sonnet for complex ones. Automatic fallback to Sonnet if Haiku returns bad JSON.

1. `reminder` — set reminders with priority, sharing, notes. **No time given → captured as a no-time item (`remind_at` NULL), never asks for time.** No-time items show in `list` under "No time set" and are surfaced under every reminder fire; give one a time anytime ("set buy milk for 5pm") to schedule it.
2. `chat` — conversation, math, timezone, translation (multi-language responds in user's language)
3. `command` — bot actions (list, dashboard, streaks, digest, location, calendar, undo, etc.)
4. `action` — modify existing reminders (cancel, edit, reschedule, add_note)
5. `monitor` — URL watching for changes/price drops
6. `search` — find past/active reminders by text or date
7. `list` — manage lists (add, remove, show, clear)
8. `contact` — save/lookup people info and birthdays
9. `journal` — write/read/search journal entries
10. `memory` — remember/recall/forget facts ("remember TO X" = reminder, "remember X" = memory)
11. `expense` — log spending, view summaries
12. `timer` — pomodoro/focus timers
13. `summarize` — fetch and summarize URLs (result stored in history for follow-up questions)
14. `project` — group tasks by project (create, add_task, show, archive)
15. `pin` — pin important messages for quick reference
16. `followup` — track things you're waiting on ("reply to X", "follow up with X", "get back to X")
17. `research` — multi-source web research via DuckDuckGo + Claude synthesis
18. `email` — draft emails (only when user explicitly says "draft email" or "email to")

## Conversation History

- Stored in Postgres `chat_history` table — survives deploys
- Retained 60 days per chat (safety cap of 5000 msgs/chat, rarely hit); auto-pruned by cleanup cron
- Adaptive history sent to AI: 0 for simple commands, 10 for normal, 20 for context-dependent
- Each message capped at 2000 chars
- Richer context stored for non-chat intents (reminder text, expense amounts, etc.)
- **Semantic recall:** each message is embedded via Voyage AI (`voyage-3-lite`, 512-dim, `src/embeddings.js`) and stored in a `pgvector` column. On every non-trivial message, `getRelevantHistory()` (`src/db.js`) semantically searches the chat's older history (>1h old, ≥0.75 cosine similarity) and injects the top matches into the AI prompt via `formatRetrievedContext()` — implicit, no command needed (e.g. "what was that thing about the factory guy?" just works). Fully inert if `VOYAGE_API_KEY` is unset or Voyage is unreachable — never blocks or breaks the chat flow. Message text is sent to Voyage for embedding, in addition to Anthropic.

## Cron Jobs (both platforms)

| Schedule | Job |
|----------|-----|
| `*/2 * * * *` | Missed reminder safety net — fires unfired past-due reminders |
| `*/15 * * * *` | Google Calendar sync — polls for new events |
| `*/30 * * * *` | URL monitor check — content hash comparison |
| `0 */6 * * *` | Ignored reminder alerts + follow-up due notifications |
| `0 */12 * * *` | Idle check-in — notifies if 2+ days without messaging |
| `0 3 * * *` | Auto-cleanup — prune stale data |
| `0 8 * * *` | Birthday check — notify today + 3 days ahead |
| `* * * * *` | Daily digest — optimized: queries only users with matching digest_time |
| `0 19 * * 0` | Week planning — Sunday 7pm overview |
| `0 21 * * 1-6` | EOD recap — Mon-Sat 9pm (spending, pending, tomorrow's schedule) |
| `0 21 * * 0` | Weekly summary — Sundays 9pm |

## Safety & Performance

- **Smart model selection:** Haiku ($1/M input) for simple intents, Sonnet ($3/M) for complex. ~250 msgs/$1 average
- **Rate limiting:** 30 API calls/min per chat, 200 total/min
- **API retry:** WhatsApp API uses fetchWithRetry with exponential backoff (1s/2s/4s) on 429/5xx/timeout
- **Webhook security:** HMAC-SHA256 signature verification on all incoming webhooks, 1MB body limit
- **Message deduplication:** Tracks 10k message IDs to prevent double-processing from Meta retries
- **Memory management:** All in-memory Maps capped at 500 entries, pending Maps auto-cleared every 30 min
- **DB resilience:** Connection retry (5 attempts with backoff), pool error handler, 10s connect timeout, 30s statement timeout, max 20 connections
- **DB indexes:** 13 indexes on frequently queried columns (reminders, contacts, lists, expenses, journal, memory, followups, pins, projects)
- **File size limits:** 20MB cap on media downloads before buffering
- **Fetch timeouts:** All HTTP calls have AbortSignal.timeout (10-30s depending on operation)
- **Process stability:** uncaughtException + unhandledRejection handlers, graceful SIGTERM/SIGINT shutdown with DB pool close
- **Auto-cleanup:** Daily at 3am prunes stale reminders (30d), deactivated (90d), completed (6mo), chat history (60d), expenses (1yr)
- **Haiku fallback:** If Haiku returns malformed JSON, automatically retries with Sonnet once instead of triggering 60s cooldown

## Important Patterns

- **Dual-platform parity:** All 18 intents handled on both Telegram and WhatsApp. Every cron job runs for both platforms.
- **WhatsApp 3-button limit:** Interactive messages max 3 buttons. Smart follow-up after 3+ snoozes: Tomorrow 9am / Drop it / Done.
- **Reply-to-message:** `messageReminderMap` (Map, capped at 500) tracks bot message IDs → reminder IDs for reply-based actions.
- **Photo/document flow:** Photos stored as pending → user chooses: set reminder time, analyze, or save. Documents auto-analyzed (PDFs via Claude Vision).
- **AI-first routing:** All messages go through Claude AI before chrono-node fallback parser.
- **Time validation:** Bare day names ("tomorrow") without time trigger `needsInfo` — bot asks "What time?"
- **Context detection:** Phrases like "add it", "that one", "you mentioned" trigger full history + Sonnet for accurate back-references.
- **Priority re-fire:** Urgent reminders re-fire every 5 min up to 3 times if no response.
- **Future-only scheduling:** `saveAndConfirm` only schedules reminders with future `remind_at` to prevent accidental immediate fire.
- **Conflict detection:** Warns when new reminder is within 30 min of existing ones.
- **Universal undo:** Reverts last pin/follow-up/project action, then falls back to reminder undo.

## Environment Variables (Railway)

```
TELEGRAM_BOT_TOKEN
ANTHROPIC_API_KEY
WHATSAPP_ACCESS_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_BUSINESS_ACCOUNT_ID
WHATSAPP_TO_NUMBER
WHATSAPP_VERIFY_TOKEN
META_APP_SECRET
DATABASE_URL (Railway Postgres reference)
TIMEZONE=Asia/Amman
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
HEALTHCHECK_URL (optional — external dead-man's-switch ping target, e.g. healthchecks.io)
VOYAGE_API_KEY (optional — enables chat-memory semantic recall; feature is fully inert if unset)
```

## Reliability & CI

- **External heartbeat:** `src/monitor.js` `startHeartbeat()` pings `HEALTHCHECK_URL` every 2 min. If the process crashes/loops, pings stop and the external service (healthchecks.io) alerts the owner. No-op if unset.
- **Internal self-check:** `startSelfCheck()` probes the DB every 5 min; after 2 consecutive failures it texts the owner (`WHATSAPP_TO_NUMBER`) via WhatsApp, with a 30-min cooldown, and sends a recovery note when the DB returns.
- **Tests:** `npm test` runs `node --test test/*.test.js`. Pure-logic tests (`test/handlers.test.js`) always run; DB smoke tests (`test/db.test.js`) only run when `DATABASE_URL` is set.
- **CI:** `.github/workflows/ci.yml` runs on push/PR against a **`pgvector/pgvector:pg18`** service container (not the plain `postgres:18` image) — needed because chat-memory semantic recall requires the `pgvector` extension, which the official Postgres image doesn't bundle. Also catches PG18 type-coercion bugs that local SQLite never sees.

## User Preferences

- Timezone: Asia/Amman (UTC+3)
- Concise responses, minimal emoji clutter
- Bot should feel like texting a smart friend
- AI-first intent classification — natural language over commands
- Letter IDs (a, b, c) in list views, not numbers
- Dashboard omits settings unless explicitly asked
- "Reply to [person]" = follow-up tracking, not email

## Common Issues

- **SQLite incompatible:** All new tables/columns only exist in Postgres init. Local dev with SQLite will fail for new features.
- **Deploy restarts:** In-memory timers lost on deploy. Missed reminder cron (every 2 min) catches unfired reminders.
- **WhatsApp media:** Images stored as BYTEA in Postgres, re-uploaded at fire time via `uploadMedia()`.
- **AI token costs:** ~$0.004 avg per message with smart model selection. Monitor Anthropic credit usage.
- **DB connection timeout:** Railway Postgres may be slow on cold starts. Connection retry with 5 attempts handles this.
- **Haiku model:** Uses `claude-haiku-4-5-20251001`. If API changes model names, update in `src/ai.js`.
