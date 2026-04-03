/**
 * Database layer — uses Postgres if DATABASE_URL is set, otherwise falls back to SQLite.
 * All functions are synchronous when using SQLite, async when using Postgres.
 * Since all callers are in async contexts, we export async functions that work with both.
 */
import pg from 'pg';

const { Pool } = pg;

let pool;
let isPostgres = false;

// SQLite fallback for local dev
let sqliteDb = null;

async function initPostgres() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      text TEXT NOT NULL,
      remind_at TEXT NOT NULL,
      cron_expr TEXT,
      timezone TEXT DEFAULT 'UTC',
      category TEXT,
      snoozed_until TEXT,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      snooze_count INTEGER DEFAULT 0,
      last_fired_at TEXT,
      ignored_since TEXT,
      notes TEXT,
      media_type TEXT,
      media_id TEXT,
      media_data BYTEA
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      chat_id TEXT PRIMARY KEY,
      timezone TEXT DEFAULT 'UTC',
      daily_digest INTEGER DEFAULT 0,
      digest_time TEXT DEFAULT '08:00'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS completed_reminders (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      text TEXT NOT NULL,
      completed_at TIMESTAMPTZ DEFAULT NOW(),
      original_remind_at TEXT,
      day_of_week INTEGER,
      hour INTEGER,
      minute INTEGER
    )
  `);

  // Add media_data column if missing (migration)
  try {
    await pool.query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS media_data BYTEA`);
  } catch {}

  isPostgres = true;
  console.log('[DB] Connected to Postgres');
}

async function initSqlite() {
  const { default: Database } = await import('better-sqlite3');
  const { mkdirSync } = await import('fs');
  const { dirname, join } = await import('path');
  const { fileURLToPath } = await import('url');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const dataDir = join(__dirname, '..', 'data');
  mkdirSync(dataDir, { recursive: true });

  sqliteDb = new Database(join(dataDir, 'reminders.db'));
  sqliteDb.pragma('journal_mode = WAL');

  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, text TEXT NOT NULL,
      remind_at TEXT NOT NULL, cron_expr TEXT, timezone TEXT DEFAULT 'UTC', category TEXT,
      snoozed_until TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')),
      snooze_count INTEGER DEFAULT 0, last_fired_at TEXT, ignored_since TEXT,
      notes TEXT, media_type TEXT, media_id TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      chat_id TEXT PRIMARY KEY, timezone TEXT DEFAULT 'UTC',
      daily_digest INTEGER DEFAULT 0, digest_time TEXT DEFAULT '08:00'
    );
    CREATE TABLE IF NOT EXISTS completed_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, text TEXT NOT NULL,
      completed_at TEXT DEFAULT (datetime('now')), original_remind_at TEXT,
      day_of_week INTEGER, hour INTEGER, minute INTEGER
    );
  `);

  console.log('[DB] Using SQLite (local)');
}

// Initialize
if (process.env.DATABASE_URL) {
  await initPostgres();
} else {
  await initSqlite();
}

// --- Helper for running queries ---

async function query(sql, params = []) {
  if (isPostgres) {
    // Convert ? placeholders to $1, $2, etc.
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    const result = await pool.query(pgSql, params);
    return result;
  } else {
    return { rows: sqliteDb.prepare(sql).all(...params), rowCount: 0 };
  }
}

async function queryOne(sql, params = []) {
  if (isPostgres) {
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    const result = await pool.query(pgSql, params);
    return result.rows[0] || null;
  } else {
    return sqliteDb.prepare(sql).get(...params) || null;
  }
}

async function run(sql, params = []) {
  if (isPostgres) {
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    const result = await pool.query(pgSql, params);
    return { changes: result.rowCount, lastInsertRowid: null };
  } else {
    const result = sqliteDb.prepare(sql).run(...params);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }
}

async function insert(sql, params = []) {
  if (isPostgres) {
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`) + ' RETURNING id';
    const result = await pool.query(pgSql, params);
    return result.rows[0]?.id;
  } else {
    const result = sqliteDb.prepare(sql).run(...params);
    return result.lastInsertRowid;
  }
}

// --- Reminder CRUD ---

export async function createReminder({ chatId, text, remindAt, cronExpr, timezone, category }) {
  return insert(
    'INSERT INTO reminders (chat_id, text, remind_at, cron_expr, timezone, category) VALUES (?, ?, ?, ?, ?, ?)',
    [chatId, text, remindAt, cronExpr || null, timezone || 'UTC', category || null]
  );
}

export async function getReminder(id) {
  return queryOne('SELECT * FROM reminders WHERE id = ?', [id]);
}

export async function reactivateReminder(id) {
  await run('UPDATE reminders SET active = 1 WHERE id = ?', [id]);
}

export async function getLastDeactivated(chatId) {
  return queryOne('SELECT * FROM reminders WHERE chat_id = ? AND active = 0 ORDER BY id DESC LIMIT 1', [chatId]);
}

export async function getWeeklyStats(chatId) {
  const completed = (await queryOne(
    "SELECT COUNT(*) as count FROM completed_reminders WHERE chat_id = ? AND completed_at > NOW() - INTERVAL '7 days'", [chatId]
  ))?.count || 0;
  const snoozed = (await queryOne(
    "SELECT COUNT(*) as count FROM reminders WHERE chat_id = ? AND snooze_count > 0 AND created_at > NOW() - INTERVAL '7 days'", [chatId]
  ))?.count || 0;
  const missed = (await queryOne(
    "SELECT COUNT(*) as count FROM reminders WHERE chat_id = ? AND active = 0 AND ignored_since IS NOT NULL AND created_at > NOW() - INTERVAL '7 days'", [chatId]
  ))?.count || 0;
  return { completed: Number(completed), snoozed: Number(snoozed), missed: Number(missed) };
}

export async function getActiveReminders(chatId) {
  return (await query('SELECT * FROM reminders WHERE chat_id = ? AND active = 1 ORDER BY remind_at ASC', [chatId])).rows;
}

export async function getAllActiveReminders() {
  return (await query('SELECT * FROM reminders WHERE active = 1')).rows;
}

export async function deactivateReminder(id) {
  await run('UPDATE reminders SET active = 0 WHERE id = ?', [id]);
}

export async function snoozeReminder(id, newTime) {
  await run('UPDATE reminders SET remind_at = ?, snoozed_until = ? WHERE id = ?', [newTime, newTime, id]);
}

export async function updateReminderTime(id, newTime) {
  await run('UPDATE reminders SET remind_at = ? WHERE id = ?', [newTime, id]);
}

// Settings

export async function getSettings(chatId) {
  let settings = await queryOne('SELECT * FROM settings WHERE chat_id = ?', [chatId]);
  if (!settings) {
    await run('INSERT INTO settings (chat_id) VALUES (?)', [chatId]);
    settings = { chat_id: chatId, timezone: process.env.TIMEZONE || 'UTC', daily_digest: 0, digest_time: '08:00' };
  }
  return settings;
}

export async function setTimezone(chatId, timezone) {
  await getSettings(chatId);
  await run('UPDATE settings SET timezone = ? WHERE chat_id = ?', [timezone, chatId]);
}

export async function setDailyDigest(chatId, enabled, time) {
  await getSettings(chatId);
  await run('UPDATE settings SET daily_digest = ?, digest_time = ? WHERE chat_id = ?', [enabled ? 1 : 0, time || '08:00', chatId]);
}

export async function getTodaysReminders(chatId, dateStr) {
  return (await query("SELECT * FROM reminders WHERE chat_id = ? AND active = 1 AND remind_at::date = ?::date ORDER BY remind_at ASC", [chatId, dateStr])).rows;
}

export async function deactivateTodaysReminders(chatId, dateStr) {
  const result = await run("UPDATE reminders SET active = 0 WHERE chat_id = ? AND active = 1 AND cron_expr IS NULL AND remind_at::date = ?::date", [chatId, dateStr]);
  return result.changes;
}

export async function deactivateAllReminders(chatId) {
  const result = await run('UPDATE reminders SET active = 0 WHERE chat_id = ? AND active = 1', [chatId]);
  return result.changes;
}

export async function pauseAllReminders(chatId) {
  const result = await run('UPDATE reminders SET active = 2 WHERE chat_id = ? AND active = 1', [chatId]);
  return result.changes;
}

export async function resumeAllReminders(chatId) {
  const result = await run('UPDATE reminders SET active = 1 WHERE chat_id = ? AND active = 2', [chatId]);
  return result.changes;
}

export async function getPausedReminders(chatId) {
  return (await query('SELECT * FROM reminders WHERE chat_id = ? AND active = 2 ORDER BY remind_at ASC', [chatId])).rows;
}

export async function updateReminderText(id, newText) {
  await run('UPDATE reminders SET text = ? WHERE id = ?', [newText, id]);
}

export async function addNoteToReminder(id, note) {
  const existing = await queryOne('SELECT notes FROM reminders WHERE id = ?', [id]);
  const current = existing?.notes || '';
  const updated = current ? `${current}\n${note}` : note;
  await run('UPDATE reminders SET notes = ? WHERE id = ?', [updated, id]);
}

export async function attachMedia(id, mediaType, mediaId) {
  await run('UPDATE reminders SET media_type = ?, media_id = ? WHERE id = ?', [mediaType, mediaId, id]);
}

export async function attachMediaWithData(id, mediaType, mediaId, buffer) {
  console.log(`[DB] attachMediaWithData id=${id} type=${mediaType} mime=${mediaId} buffer_len=${buffer?.length || 0}`);
  if (isPostgres) {
    await pool.query(
      'UPDATE reminders SET media_type = $1, media_id = $2, media_data = $3 WHERE id = $4',
      [mediaType, mediaId, buffer, id]
    );
  } else {
    await run('UPDATE reminders SET media_type = ?, media_id = ? WHERE id = ?', [mediaType, mediaId, id]);
  }
}

export async function getLastReminder(chatId) {
  return queryOne('SELECT * FROM reminders WHERE chat_id = ? AND active = 1 ORDER BY id DESC LIMIT 1', [chatId]);
}

// Snooze tracking

export async function incrementSnoozeCount(id) {
  await run('UPDATE reminders SET snooze_count = snooze_count + 1 WHERE id = ?', [id]);
}

export async function getSnoozeCount(id) {
  const row = await queryOne('SELECT snooze_count FROM reminders WHERE id = ?', [id]);
  return row?.snooze_count || 0;
}

export async function resetSnoozeCount(id) {
  await run('UPDATE reminders SET snooze_count = 0, ignored_since = NULL WHERE id = ?', [id]);
}

// Fired / ignored tracking

export async function markReminderFired(id) {
  await run("UPDATE reminders SET last_fired_at = NOW(), ignored_since = COALESCE(ignored_since, NOW()) WHERE id = ?", [id]);
}

export async function clearIgnoredSince(id) {
  await run('UPDATE reminders SET ignored_since = NULL WHERE id = ?', [id]);
}

export async function getIgnoredReminders(chatId) {
  return (await query(
    "SELECT * FROM reminders WHERE chat_id = ? AND active = 1 AND ignored_since IS NOT NULL AND NOW() - ignored_since::timestamptz >= INTERVAL '3 days'",
    [chatId]
  )).rows;
}

// Completed reminders

export async function logCompletedReminder({ chatId, text, remindAt }) {
  const d = new Date(remindAt);
  await insert(
    'INSERT INTO completed_reminders (chat_id, text, original_remind_at, day_of_week, hour, minute) VALUES (?, ?, ?, ?, ?, ?)',
    [chatId, text, remindAt, d.getDay(), d.getHours(), d.getMinutes()]
  );
}

export async function getCompletedReminders(chatId, daysBack = 28) {
  return (await query(
    "SELECT * FROM completed_reminders WHERE chat_id = ? AND completed_at > NOW() - INTERVAL '1 day' * ? ORDER BY completed_at DESC",
    [chatId, daysBack]
  )).rows;
}
