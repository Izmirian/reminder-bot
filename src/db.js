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
      digest_time TEXT DEFAULT '08:00',
      location TEXT
    )
  `);
  try { await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS location TEXT`); } catch {}

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

  // Streaks table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS streaks (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      reminder_text TEXT NOT NULL,
      cron_expr TEXT,
      current_streak INTEGER DEFAULT 0,
      longest_streak INTEGER DEFAULT 0,
      last_completed DATE,
      UNIQUE(chat_id, reminder_text)
    )
  `);

  // URL monitors table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS url_monitors (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      url TEXT NOT NULL,
      label TEXT,
      check_type TEXT DEFAULT 'change',
      last_hash TEXT,
      last_price REAL,
      last_checked TIMESTAMPTZ,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Migrations
  try {
    await pool.query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS media_data BYTEA`);
    await pool.query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal'`);
    await pool.query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS fire_count INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS shared_with TEXT`);
    await pool.query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS created_by TEXT`);
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

export async function createReminder({ chatId, text, remindAt, cronExpr, timezone, category, priority, sharedWith, createdBy }) {
  return insert(
    'INSERT INTO reminders (chat_id, text, remind_at, cron_expr, timezone, category, priority, shared_with, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [chatId, text, remindAt, cronExpr || null, timezone || 'UTC', category || null, priority || 'normal', sharedWith ? JSON.stringify(sharedWith) : null, createdBy || null]
  );
}

export async function incrementFireCount(id) {
  await run('UPDATE reminders SET fire_count = fire_count + 1 WHERE id = ?', [id]);
}

export async function getFireCount(id) {
  const row = await queryOne('SELECT fire_count FROM reminders WHERE id = ?', [id]);
  return row?.fire_count || 0;
}

export async function resetFireCount(id) {
  await run('UPDATE reminders SET fire_count = 0 WHERE id = ?', [id]);
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

export async function setLocation(chatId, location) {
  await getSettings(chatId);
  await run('UPDATE settings SET location = ? WHERE chat_id = ?', [location, chatId]);
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

// Search reminders (active + completed) by text and/or date range
export async function searchReminders(chatId, searchQuery, fromDate, toDate) {
  const results = { active: [], completed: [] };

  if (searchQuery) {
    const pattern = `%${searchQuery}%`;
    results.active = (await query(
      'SELECT * FROM reminders WHERE chat_id = ? AND text ILIKE ? ORDER BY remind_at DESC LIMIT 20',
      [chatId, pattern]
    )).rows;
    results.completed = (await query(
      'SELECT * FROM completed_reminders WHERE chat_id = ? AND text ILIKE ? ORDER BY completed_at DESC LIMIT 20',
      [chatId, pattern]
    )).rows;
  } else if (fromDate && toDate) {
    results.active = (await query(
      'SELECT * FROM reminders WHERE chat_id = ? AND remind_at >= ? AND remind_at <= ? ORDER BY remind_at DESC LIMIT 20',
      [chatId, fromDate, toDate]
    )).rows;
    results.completed = (await query(
      'SELECT * FROM completed_reminders WHERE chat_id = ? AND completed_at >= ?::timestamptz AND completed_at <= ?::timestamptz ORDER BY completed_at DESC LIMIT 20',
      [chatId, fromDate, toDate]
    )).rows;
  } else {
    // Show recent completed
    results.completed = (await query(
      "SELECT * FROM completed_reminders WHERE chat_id = ? ORDER BY completed_at DESC LIMIT 20",
      [chatId]
    )).rows;
  }

  return results;
}

// --- Streaks ---

export async function updateStreak(chatId, reminderText, cronExpr) {
  const today = new Date().toISOString().split('T')[0];
  const existing = await queryOne(
    'SELECT * FROM streaks WHERE chat_id = ? AND reminder_text = ?',
    [chatId, reminderText]
  );

  if (existing) {
    const lastDate = existing.last_completed;
    const daysDiff = lastDate ? Math.floor((new Date(today) - new Date(lastDate)) / 86400000) : 999;

    let newStreak;
    if (daysDiff <= 1) {
      // Consecutive day or same day — increment
      newStreak = (existing.current_streak || 0) + (daysDiff === 0 ? 0 : 1);
    } else {
      // Streak broken — restart at 1
      newStreak = 1;
    }
    const longest = Math.max(newStreak, existing.longest_streak || 0);
    await run(
      'UPDATE streaks SET current_streak = ?, longest_streak = ?, last_completed = ? WHERE id = ?',
      [newStreak, longest, today, existing.id]
    );
    return newStreak;
  } else {
    await insert(
      'INSERT INTO streaks (chat_id, reminder_text, cron_expr, current_streak, longest_streak, last_completed) VALUES (?, ?, ?, ?, ?, ?)',
      [chatId, reminderText, cronExpr || null, 1, 1, today]
    );
    return 1;
  }
}

export async function breakStreak(chatId, reminderText) {
  await run(
    'UPDATE streaks SET current_streak = 0 WHERE chat_id = ? AND reminder_text = ?',
    [chatId, reminderText]
  );
}

export async function getStreak(chatId, reminderText) {
  return queryOne('SELECT * FROM streaks WHERE chat_id = ? AND reminder_text = ?', [chatId, reminderText]);
}

export async function getAllStreaks(chatId) {
  return (await query('SELECT * FROM streaks WHERE chat_id = ? AND current_streak > 0 ORDER BY current_streak DESC', [chatId])).rows;
}

// --- URL Monitors ---

export async function createUrlMonitor({ chatId, url, label, checkType }) {
  return insert(
    'INSERT INTO url_monitors (chat_id, url, label, check_type) VALUES (?, ?, ?, ?)',
    [chatId, url, label || null, checkType || 'change']
  );
}

export async function getActiveMonitors() {
  return (await query('SELECT * FROM url_monitors WHERE active = 1')).rows;
}

export async function getUserMonitors(chatId) {
  return (await query('SELECT * FROM url_monitors WHERE chat_id = ? AND active = 1 ORDER BY created_at DESC', [chatId])).rows;
}

export async function updateMonitorHash(id, hash) {
  await run('UPDATE url_monitors SET last_hash = ?, last_checked = NOW() WHERE id = ?', [hash, id]);
}

export async function updateMonitorPrice(id, price) {
  await run('UPDATE url_monitors SET last_price = ?, last_checked = NOW() WHERE id = ?', [price, id]);
}

export async function deactivateMonitor(id) {
  await run('UPDATE url_monitors SET active = 0 WHERE id = ?', [id]);
}
