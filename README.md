# Personal Assistant Bot

A dual-platform (Telegram + WhatsApp) AI personal assistant powered by Claude. Runs on Railway with Postgres.

## What it does

- **Reminders** with natural language ("remind me tomorrow at 9am to call mom") and recurring schedules
- **Smart daily brief** — calendar events, overdue items, follow-ups, streaks, personalized news
- **Voice notes** — send a voice message, the bot transcribes and acts on it
- **Location-aware reminders** — share your location, see nearby location-tagged tasks
- **Reaction shortcuts** — 👍 = done, ⏰ = snooze, ❌ = cancel
- **Expense tracking** with auto-detection and receipt scanning
- **Google Calendar** two-way sync
- **Lists, contacts, journal, memory, projects, follow-ups, URL monitoring**
- **Weekly review** — Sunday evening recap of your week
- **Receipt scanning** — send a photo of a receipt, it logs the expense

18 AI intents, smart model selection (Haiku/Sonnet) for cost optimization.

## Setup

See **[SETUP.md](./SETUP.md)** for a complete step-by-step guide (~30 min for Telegram only, ~90 min with WhatsApp).

Quick start:
1. Fork this repo on GitHub
2. Deploy to Railway → add Postgres → set env vars
3. Create a Telegram bot via @BotFather → paste token
4. Optional: configure WhatsApp, Google Calendar, voice notes, GitHub

## Tech stack

- **Runtime:** Node.js 20+ (ES modules)
- **AI:** Claude (Sonnet + Haiku) via `@anthropic-ai/sdk`
- **DB:** Postgres (Railway) with 16 tables, 13 indexes
- **Scheduling:** `node-cron` + `setTimeout`
- **Telegram:** `node-telegram-bot-api` (long polling)
- **WhatsApp:** Express webhook for Meta Cloud API v22.0
- **Optional:** OpenAI Whisper (voice), Google Calendar, GitHub API

## Cost estimate

- **Railway:** ~$5/mo (free tier covers ~500 hours)
- **Anthropic:** ~$0.004/message with smart model routing (~$3–5/mo for heavy personal use)
- **OpenAI (voice notes):** ~$0.006/min (~$1/mo unless you send lots of voice notes)
- **WhatsApp/Telegram APIs:** free

Total: **~$10/mo** for personal use.

## License

MIT — do what you want with it.
