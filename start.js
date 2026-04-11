/**
 * Unified entry point — runs both Telegram and WhatsApp bots in a single process.
 * Used for cloud deployment (Railway) where both bots share one service.
 */
import 'dotenv/config';

// Validate required environment variables
const required = ['DATABASE_URL', 'TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'];
const missing = required.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`FATAL: Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

// Prevent process crashes from unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

// Start Telegram bot
import './src/index.js';

// Start WhatsApp bot (webhook server)
import './src/whatsapp/index.js';
