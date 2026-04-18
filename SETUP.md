# Setup Guide

This walks you through deploying your own copy of the bot from scratch. Allow ~30 min for Telegram-only, ~90 min if you also want WhatsApp (WhatsApp setup is the painful part — Meta approval).

## What you need before starting

- **GitHub account** (free)
- **Railway account** (free tier works, card optional for $5/mo credit)
- **Anthropic API account** — [console.anthropic.com](https://console.anthropic.com). Add $5 credit, that goes a long way
- **Telegram account** (if you want Telegram — just the app on your phone)
- **Meta/Facebook developer account** (if you want WhatsApp — free, needs Facebook login)
- **OpenAI API account** (optional, for voice note transcription — add $5)
- **Google Cloud account** (optional, for calendar sync — free)

---

## Step 1: Fork & deploy to Railway

1. **Fork this repo** on GitHub (click Fork top-right). You now own a copy.
2. Go to [railway.app](https://railway.app) and sign in with GitHub.
3. Click **New Project** → **Deploy from GitHub repo** → select your fork.
4. Railway builds the app. It will fail first time (no env vars yet) — that's OK.
5. In your Railway project: **+ New** → **Database** → **Add PostgreSQL**. Wait ~30 sec.
6. Click the **Postgres service** → **Variables** tab → copy the `DATABASE_URL` value (starts with `postgresql://...`).

Railway auto-redeploys every time you push to GitHub. 🎉

---

## Step 2: Set required environment variables

Click your **bot service** (not the Postgres one) → **Variables** tab → add these:

### Required (minimum to start)

```
DATABASE_URL=postgresql://...    # Paste the one from step 1.6
ANTHROPIC_API_KEY=sk-ant-...     # From console.anthropic.com → API Keys
TIMEZONE=Asia/Amman              # Your timezone (see list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)
```

At this point the bot will start but won't do anything — you need at least one messaging platform.

---

## Step 3: Add Telegram (easy — 5 min)

1. On Telegram, message **@BotFather** → `/newbot` → pick a name and username (must end in `bot`).
2. BotFather gives you a token like `123456789:ABCdef...`. Copy it.
3. Go back to Railway → Variables → add:
   ```
   TELEGRAM_BOT_TOKEN=123456789:ABCdef...
   ```
4. Railway redeploys automatically (~1 min).
5. Open your bot on Telegram and say "hi" — it should respond.

**That's it for Telegram.** Skip to Step 5 if you don't want WhatsApp.

---

## Step 4: Add WhatsApp (painful — 30-60 min)

WhatsApp setup is tedious because Meta requires business account approval. Budget an hour.

### 4a. Meta Developer Setup

1. Go to [developers.facebook.com](https://developers.facebook.com) → log in with Facebook → **My Apps** → **Create App**.
2. Pick **Business** type → fill out name/email.
3. On the app dashboard, find **WhatsApp** product → click **Set up**.
4. Meta gives you a **test phone number** (use this for now) and a **temporary access token** (expires in 24h — we'll fix this).
5. Note down:
   - **Phone number ID** (under "From")
   - **WhatsApp Business Account ID** (under settings)
   - **Temporary access token**

### 4b. Create a permanent access token

The temp token expires. For production:
1. In Meta → **Business Settings** → **System Users** → **Add** → name it "BotSystemUser" → Admin role.
2. Click the system user → **Add Assets** → add your WhatsApp app.
3. Click **Generate New Token** → select your app → permissions: `whatsapp_business_messaging` + `whatsapp_business_management` → **never expires**.
4. Copy the token. This is your permanent `WHATSAPP_ACCESS_TOKEN`.

### 4c. Get your App Secret

1. In Meta dashboard → **Settings** → **Basic** → copy **App Secret**. This is `META_APP_SECRET`.

### 4d. Add WhatsApp env vars to Railway

```
WHATSAPP_ACCESS_TOKEN=EAAxxxx...            # The permanent token from 4b
WHATSAPP_PHONE_NUMBER_ID=123456789          # From 4a
WHATSAPP_BUSINESS_ACCOUNT_ID=123456789      # From 4a
WHATSAPP_TO_NUMBER=962790000000             # YOUR phone number in international format (no +)
WHATSAPP_VERIFY_TOKEN=pick_any_random_string  # e.g. "mybot_webhook_2026" — you'll use it in 4e
META_APP_SECRET=abc123...                   # From 4c
```

### 4e. Configure webhook in Meta

1. In Railway, click your bot service → **Settings** → **Networking** → **Generate Domain**. Copy the URL (like `your-bot.up.railway.app`).
2. In Meta → WhatsApp → Configuration → **Webhook** → **Edit**:
   - Callback URL: `https://your-bot.up.railway.app/webhook`
   - Verify Token: same string you used for `WHATSAPP_VERIFY_TOKEN`
   - Click **Verify and Save**.
3. Under **Webhook fields**, subscribe to: `messages`, `message_reactions`.

### 4f. Add your phone as a tester

While your WhatsApp app is in test mode, only allowed phone numbers can message it.
1. In Meta → WhatsApp → API Setup → scroll to "To" → **Add phone number** → enter your phone → verify via code.
2. Send a test message from the Meta dashboard to confirm it works.

Now from your own WhatsApp, send a message to the **Meta test number** (shown under "From" in the API Setup). Your bot should reply.

**Going to production:** you'll need to register your own phone number with WhatsApp Business and go through Meta's business verification. That's a separate process. For personal use, the test number works fine.

---

## Step 5: Optional enhancements

All optional — add whichever you want:

### Voice note transcription (highly recommended)

1. Go to [platform.openai.com](https://platform.openai.com) → **API Keys** → create one.
2. Add $5 credit under **Billing**.
3. In Railway, add:
   ```
   OPENAI_API_KEY=sk-...
   ```
Now voice notes sent to the bot get transcribed and processed like text.

### Google Calendar sync

1. [Google Cloud Console](https://console.cloud.google.com) → New Project → enable **Google Calendar API**.
2. **OAuth consent screen** → External → fill out basic info (your email, "test users" with your Google email).
3. **Credentials** → **Create credentials** → **OAuth client ID** → Web application.
4. **Authorized redirect URIs**: `https://your-bot.up.railway.app/auth/google/callback`
5. Copy Client ID and Secret.
6. Railway env vars:
   ```
   GOOGLE_CLIENT_ID=123-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```
7. On your bot, say "connect calendar" → follow the link → authorize.

### GitHub integration (ask the bot about your code)

1. [github.com/settings/tokens](https://github.com/settings/tokens) → **Fine-grained personal access token**.
2. Give it read access to the repo you want.
3. Railway env vars:
   ```
   GITHUB_TOKEN=github_pat_...
   GITHUB_REPO=yourusername/yourrepo
   ```
Now you can ask: "any open PRs?", "recent commits", "show me src/app.js".

---

## Step 6: Verify it's working

Send these messages to your bot:

- `"remind me in 5 minutes to drink water"` — should confirm, then remind you in 5 min
- `"dashboard"` — should show an overview
- `"log 10 coffee"` — logs an expense
- `"add milk to grocery list"` — creates/updates a list
- `"remember that my blood type is O+"` — saves a memory

If all of those work, you're good. 🎉

---

## Troubleshooting

**Bot doesn't respond on Telegram**
- Check Railway logs (Deploy tab → Logs) for `Bot started` message.
- Make sure `TELEGRAM_BOT_TOKEN` is set and redeployment finished.

**Bot doesn't respond on WhatsApp**
- Check webhook subscription in Meta dashboard is green/verified.
- Check Railway logs for `[Webhook] Invalid signature` — means `META_APP_SECRET` is wrong.
- Confirm your phone is added as a tester (step 4f).

**Postgres connection errors on deploy**
- Railway Postgres sometimes takes 30+ sec to start. Wait and retry.
- Confirm `DATABASE_URL` is the reference from the Postgres service, not a copy-pasted older value.

**AI responses are weird or slow**
- Check Anthropic credit balance at console.anthropic.com.
- Rate limiting: 30 calls/min per chat, 200/min total.

**WhatsApp access token expired**
- Temporary tokens expire in 24h. Use a system user token (step 4b) for permanence.

---

## Your .env file

A complete `.env.example` is included with all possible variables and comments. Copy `.env.example` to `.env` for local development, or set these directly in Railway Variables for production.

---

## Customizing

After the bot is running, you'll probably want to tweak things. Key files:

| File | What to change |
|------|----------------|
| `src/ai.js` | AI prompts, intent definitions |
| `src/assistant.js` | Handlers for lists/contacts/journal/expenses/etc |
| `src/whatsapp/handler.js` | WhatsApp message routing |
| `src/index.js` | Telegram message routing |
| `src/scheduler.js` | Telegram cron jobs (daily digest, weekly review) |
| `src/whatsapp/scheduler.js` | WhatsApp cron jobs |
| `src/db.js` | Database schema and queries |
| `src/config.js` | Constants (rate limits, timeouts) |

Commit changes to your GitHub fork → Railway auto-deploys.

Enjoy! If something breaks, check Railway logs first.
