/**
 * Unified entry point — runs both Telegram and WhatsApp bots in a single process.
 * Used for cloud deployment (Railway) where both bots share one service.
 */
import 'dotenv/config';

// Start Telegram bot
import './src/index.js';

// Start WhatsApp bot (webhook server)
import './src/whatsapp/index.js';
