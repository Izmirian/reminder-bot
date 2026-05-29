/**
 * Reliability monitoring.
 *
 * Two layers:
 *  1. startHeartbeat() — pings an external dead-man's-switch (healthchecks.io
 *     or similar) every 2 min. If the process dies/crash-loops, the pings stop
 *     and the external service alerts the owner. Catches full outages.
 *  2. startSelfCheck() — while the process is alive, periodically probes the DB
 *     and alerts the owner (over WhatsApp) when it's unreachable. Catches the
 *     "alive but broken" case. Sends a recovery note when it comes back.
 *
 * Both are no-ops if their required env vars are unset, so the bot runs fine
 * locally without any monitoring configured.
 */

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;  // 2 min
const SELFCHECK_INTERVAL_MS = 5 * 60 * 1000;  // 5 min
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;     // don't re-alert within 30 min
const DB_FAIL_THRESHOLD = 2;                  // consecutive failures before alerting

let dbConsecutiveFailures = 0;
let dbInIncident = false;
let lastAlertAt = 0;

/**
 * Ping the external dead-man's-switch. Safe to call with no env configured.
 */
export function startHeartbeat() {
  const url = process.env.HEALTHCHECK_URL;
  if (!url) {
    console.log('[Monitor] HEALTHCHECK_URL not set — external heartbeat disabled.');
    return;
  }
  const ping = async () => {
    try {
      await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
    } catch (err) {
      // A failed ping just means this beat is missed; the external service
      // handles the alerting. Never let it crash the process.
      console.warn('[Monitor] Heartbeat ping failed:', err.message);
    }
  };
  ping(); // immediate first beat
  setInterval(ping, HEARTBEAT_INTERVAL_MS);
  console.log('[Monitor] External heartbeat started (every 2 min).');
}

/**
 * Send an alert to the owner over WhatsApp, with a cooldown so an ongoing
 * incident doesn't spam. `force` bypasses the cooldown (used for recovery).
 */
export async function alertOwner(message, { force = false } = {}) {
  const to = process.env.WHATSAPP_TO_NUMBER;
  if (!to) {
    console.warn('[Monitor] WHATSAPP_TO_NUMBER not set — cannot alert owner:', message);
    return;
  }
  const now = Date.now();
  if (!force && now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now;
  try {
    const { sendTextMessage } = await import('./whatsapp/api.js');
    await sendTextMessage(to, message);
  } catch (err) {
    console.error('[Monitor] Failed to send owner alert:', err.message);
  }
}

/**
 * Periodically probe the DB; alert on sustained failure, notify on recovery.
 */
export function startSelfCheck() {
  if (!process.env.WHATSAPP_TO_NUMBER) {
    console.log('[Monitor] WHATSAPP_TO_NUMBER not set — internal self-check alerts disabled.');
    return;
  }
  const check = async () => {
    try {
      const { pingDb } = await import('./db.js');
      await pingDb();
      // Healthy — if we were in an incident, announce recovery.
      if (dbInIncident) {
        dbInIncident = false;
        await alertOwner('✅ Bot recovered — database is reachable again.', { force: true });
      }
      dbConsecutiveFailures = 0;
    } catch (err) {
      dbConsecutiveFailures++;
      console.error(`[Monitor] DB self-check failed (${dbConsecutiveFailures}x):`, err.message);
      if (dbConsecutiveFailures >= DB_FAIL_THRESHOLD && !dbInIncident) {
        dbInIncident = true;
        await alertOwner(`⚠️ Bot can't reach the database (${dbConsecutiveFailures} failed checks). Reminders may not fire. Check Railway Postgres.`);
      }
    }
  };
  setInterval(check, SELFCHECK_INTERVAL_MS);
  console.log('[Monitor] Internal self-check started (every 5 min).');
}

/**
 * Called by the DB pool error handler to surface connection drops.
 */
export function signalDbError(message) {
  // Pool errors are often transient idle-connection drops; we don't alert
  // directly here (the periodic self-check decides), but we log for context.
  console.error('[Monitor] DB pool error observed:', message);
}
