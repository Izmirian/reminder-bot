/**
 * Unified entry point — runs both Telegram and WhatsApp bots in a single process.
 * Used for cloud deployment (Railway) where both bots share one service.
 */
import 'dotenv/config';

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

// Warn about missing env vars (after imports so app starts even if some are missing)
const recommended = ['DATABASE_URL', 'TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'];
const missing = recommended.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.warn(`[Startup] Missing env vars: ${missing.join(', ')} — some features may not work`);
}

// Reliability monitoring — external heartbeat + internal DB self-check.
// Both no-op if their env vars (HEALTHCHECK_URL / WHATSAPP_TO_NUMBER) are unset.
import('./src/monitor.js').then(({ startHeartbeat, startSelfCheck }) => {
  startHeartbeat();
  startSelfCheck();
}).catch(e => console.error('[Startup] Monitor failed to start:', e.message));

// Graceful shutdown — Railway sends SIGTERM before killing
async function shutdown(signal) {
  console.log(`[Shutdown] ${signal} received — cleaning up...`);
  try {
    const { closePool } = await import('./src/db.js');
    await closePool();
  } catch (e) { console.error('[Shutdown]', e.message); }
  console.log('[Shutdown] Done. Exiting.');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
