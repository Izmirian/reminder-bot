/**
 * Centralized configuration — all magic numbers in one place.
 * Override via environment variables where noted.
 */

export const CONFIG = {
  // API rate limiting
  AI_RATE_LIMIT_PER_CHAT: parseInt(process.env.AI_RATE_LIMIT_PER_CHAT || '30'),
  AI_RATE_LIMIT_TOTAL: parseInt(process.env.AI_RATE_LIMIT_TOTAL || '200'),

  // Chat history
  CHAT_HISTORY_DB_LIMIT: 200,        // Max messages stored in DB per chat
  CHAT_HISTORY_AI_CONTEXT: 20,       // Max messages sent to AI (default, adaptive overrides)
  CHAT_MESSAGE_MAX_CHARS: 2000,      // Max chars per stored message

  // Timeouts (ms)
  FETCH_TIMEOUT: 15000,              // Default fetch timeout
  UPLOAD_TIMEOUT: 30000,             // Upload timeout (larger files)
  WEATHER_TIMEOUT: 10000,            // Weather API timeout
  DB_STATEMENT_TIMEOUT: 30000,       // Max DB query execution time
  DB_CONNECTION_TIMEOUT: 5000,       // Max time to acquire DB connection

  // Limits
  DB_POOL_MAX: 20,                   // Max DB connections
  MAX_DOWNLOAD_SIZE: 20 * 1024 * 1024, // 20MB file download cap
  MESSAGE_MAP_MAX: 500,              // Max entries in messageReminderMap
  WEBHOOK_BODY_LIMIT: '1mb',         // Max webhook request body
  DEDUP_SET_MAX: 10000,              // Max tracked message IDs for dedup

  // Reminder behavior
  CONFLICT_WINDOW_MINUTES: 30,       // Warn if reminder within this window of existing
  URGENT_REFIRE_INTERVAL: 5,         // Minutes between urgent reminder re-fires
  URGENT_REFIRE_MAX: 3,              // Max re-fires for urgent reminders
  MISSED_CHECK_INTERVAL: 2,          // Minutes between missed reminder checks

  // Cleanup retention
  STALE_REMINDER_DAYS: 30,           // Auto-deactivate one-off reminders after N days
  PURGE_DEACTIVATED_DAYS: 90,        // Purge deactivated reminders after N days
  PURGE_COMPLETED_DAYS: 180,         // Purge completed reminders after N days
  PURGE_CHAT_HISTORY_DAYS: 30,       // Purge chat history after N days
  PURGE_EXPENSES_DAYS: 365,          // Purge expenses after N days

  // Idle check-in
  IDLE_CHECK_HOURS: 48,              // Notify if no message for N hours
};
