# Personal Assistant Bot

A dual-platform (Telegram + WhatsApp) AI-powered personal assistant deployed on Railway with Postgres.

## Architecture

- **Runtime:** Node.js ES modules (`"type": "module"`)
- **AI:** Claude Sonnet via `@anthropic-ai/sdk` — intent classification with 13 intents, conversation history, vision API
- **Database:** Postgres (Railway) with SQLite fallback (local dev). All DB functions are async.
- **Telegram:** `node-telegram-bot-api` with long polling
- **WhatsApp:** Express webhook server for Meta Cloud API v22.0
- **Scheduling:** `node-cron` for recurring jobs, `setTimeout` for one-off reminders
- **Deployment:** Railway auto-deploy from GitHub (`main` branch), `Procfile: web: node start.js`

## Key Files

| File | Purpose |
|------|---------|
| `start.js` | Entry point — imports both bots |
| `src/ai.js` | Claude AI intent classifier (13 intents), conversation history, prompt builder |
| `src/db.js` | All database operations — Postgres/SQLite dual-mode, 10+ tables |
| `src/assistant.js` | Shared handlers for lists, contacts, journal, memory, expenses, timers, summarizer, dashboard |
| `src/analyze.js` | Document/image analysis using Claude Vision API |
| `src/scheduler.js` | Telegram reminder scheduler, daily digest, birthday checks, cleanup crons |
| `src/index.js` | Telegram bot — message handler, callback queries, all intent routing |
| `src/whatsapp/handler.js` | WhatsApp message handler — mirrors Telegram intent routing |
| `src/whatsapp/webhook.js` | Express server — Meta webhook + Google OAuth routes |
| `src/whatsapp/scheduler.js` | WhatsApp reminder scheduler, digest, birthday checks |
| `src/whatsapp/api.js` | WhatsApp Cloud API client — send text, buttons, images, mark read |
| `src/google-calendar.js` | Google Calendar OAuth2, event CRUD, two-way sync |
| `src/url-monitor.js` | URL change/price monitoring with content hashing |
| `src/parser.js` | chrono-node fallback date parser with `looksLikeReminder()` gate |
| `src/commands.js` | Telegram slash command handlers |
| `src/context.js` | Reminder fire message builder |
| `src/conversation.js` | Fallback conversation handler when AI unavailable |
| `src/patterns.js` | Recurring pattern detection via Jaccard similarity |

## Database Tables

| Table | Purpose |
|-------|---------|
| `reminders` | Core — 20+ columns including priority, media, shared_with, google_event_id |
| `settings` | Per-user — timezone, digest, location, google_tokens |
| `completed_reminders` | Completion log with day/hour/minute for pattern detection |
| `streaks` | Recurring reminder completion streaks |
| `url_monitors` | Watched URLs with content hashes and prices |
| `lists` | Quick lists (grocery, shopping, todo) with JSONB items |
| `contacts` | People notes with birthday tracking |
| `journal` | Daily journal entries with mood |
| `memory` | Conversation facts the bot remembers |
| `expenses` | Spending tracker with categories |
| `documents` | Stored files/PDFs with binary data |
| `chat_history` | Persisted conversation history (200 msgs per chat) |

## AI Intent System

The bot classifies every message into one of 13 intents via Claude Sonnet:

1. `reminder` — set reminders with priority, sharing, notes
2. `chat` — conversation, math, timezone, translation (multi-language)
3. `command` — bot actions (list, dashboard, streaks, digest, location, calendar, etc.)
4. `action` — modify existing reminders (cancel, edit, reschedule, add_note)
5. `monitor` — URL watching for changes/price drops
6. `search` — find past/active reminders by text or date
7. `list` — manage lists (add, remove, show, clear)
8. `contact` — save/lookup people info and birthdays
9. `journal` — write/read/search journal entries
10. `memory` — remember/recall/forget facts
11. `expense` — log spending, view summaries
12. `timer` — pomodoro/focus timers
13. `summarize` — fetch and summarize URLs

## Conversation History

- Stored in Postgres `chat_history` table — survives deploys
- 200 messages (100 exchanges) retained per chat
- Last 50 messages (25 exchanges) sent to AI per request
- Each message capped at 2000 chars
- Richer context stored for non-chat intents (reminder text, expense amounts, etc.)

## Cron Jobs

| Schedule | Job |
|----------|-----|
| `*/2 * * * *` | Missed reminder safety net — fires unfired past-due reminders |
| `*/15 * * * *` | Google Calendar sync — polls for new events |
| `*/30 * * * *` | URL monitor check — content hash comparison |
| `0 */6 * * *` | Ignored reminder alerts (3+ days without response) |
| `0 3 * * *` | Auto-cleanup — prune stale data |
| `0 8 * * *` | Birthday check — notify today + 3 days ahead |
| `* * * * *` | Daily digest check — fires at user's configured time |
| `0 21 * * 0` | Weekly summary — Sundays 9pm |

## Important Patterns

- **Dual-platform:** Every feature must work on both Telegram and WhatsApp. Telegram uses `bot.sendMessage()`, WhatsApp uses `sendTextMessage()` from api.js.
- **WhatsApp 3-button limit:** Interactive messages max 3 buttons. Smart follow-up after 3+ snoozes uses: Tomorrow 9am / Drop it / Done.
- **Reply-to-message:** `messageReminderMap` (Map) tracks bot message IDs → reminder IDs for reply-based actions.
- **Photo flow:** Photos stored as pending → user provides time → reminder created with media. WhatsApp stores binary in Postgres BYTEA, Telegram uses reply-to-message.
- **AI-first routing:** All messages go through Claude AI before chrono-node fallback parser.
- **Time validation:** Bare day names ("tomorrow") without time trigger `needsInfo` — bot asks "What time?"
- **Priority re-fire:** Urgent reminders re-fire every 5 min up to 3 times if no response.
- **Future-only scheduling:** `saveAndConfirm` only schedules reminders with future `remind_at` to prevent accidental immediate fire.

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
```

## User Preferences

- Timezone: Asia/Amman (UTC+3)
- Concise responses, minimal emoji clutter
- Bot should feel like texting a smart friend
- AI-first intent classification — natural language over commands
- Letter IDs (a, b, c) in list views, not numbers

## Common Issues

- **SQLite incompatible:** All new tables/columns only exist in Postgres init. Local dev with SQLite will fail for new features.
- **Deploy restarts:** In-memory timers lost on deploy. Missed reminder cron (every 2 min) catches unfired reminders.
- **WhatsApp media:** Images stored as BYTEA in Postgres, re-uploaded at fire time via `uploadMedia()`.
- **AI token costs:** ~$0.003-0.008 per message with 50-message history context. Monitor Anthropic credit usage.
