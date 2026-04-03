import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'reminders.db');

// Ensure data directory exists (needed for cloud deploys)
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    text TEXT NOT NULL,
    remind_at TEXT NOT NULL,
    cron_expr TEXT,
    timezone TEXT DEFAULT 'UTC',
    category TEXT,
    snoozed_until TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    chat_id TEXT PRIMARY KEY,
    timezone TEXT DEFAULT 'UTC',
    daily_digest INTEGER DEFAULT 0,
    digest_time TEXT DEFAULT '08:00'
  );

  CREATE TABLE IF NOT EXISTS completed_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    text TEXT NOT NULL,
    completed_at TEXT DEFAULT (datetime('now')),
    original_remind_at TEXT,
    day_of_week INTEGER,
    hour INTEGER,
    minute INTEGER
  );
`);

// Safe column migration — add columns if they don't exist
const columns = db.prepare("PRAGMA table_info(reminders)").all().map(c => c.name);
if (!columns.includes('snooze_count')) {
  db.exec('ALTER TABLE reminders ADD COLUMN snooze_count INTEGER DEFAULT 0');
}
if (!columns.includes('last_fired_at')) {
  db.exec('ALTER TABLE reminders ADD COLUMN last_fired_at TEXT');
}
if (!columns.includes('ignored_since')) {
  db.exec('ALTER TABLE reminders ADD COLUMN ignored_since TEXT');
}
if (!columns.includes('notes')) {
  db.exec('ALTER TABLE reminders ADD COLUMN notes TEXT');
}
if (!columns.includes('media_type')) {
  db.exec('ALTER TABLE reminders ADD COLUMN media_type TEXT');  // 'photo', 'link', null
}
if (!columns.includes('media_id')) {
  db.exec('ALTER TABLE reminders ADD COLUMN media_id TEXT');    // Telegram file_id or URL
}

// Reminder CRUD

export function createReminder({ chatId, text, remindAt, cronExpr, timezone, category }) {
  const stmt = db.prepare(`
    INSERT INTO reminders (chat_id, text, remind_at, cron_expr, timezone, category)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(chatId, text, remindAt, cronExpr || null, timezone || 'UTC', category || null);
  return result.lastInsertRowid;
}

export function getReminder(id) {
  return db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
}

export function reactivateReminder(id) {
  db.prepare('UPDATE reminders SET active = 1 WHERE id = ?').run(id);
}

export function getLastDeactivated(chatId) {
  return db.prepare(
    'SELECT * FROM reminders WHERE chat_id = ? AND active = 0 ORDER BY rowid DESC LIMIT 1'
  ).get(chatId);
}

export function getWeeklyStats(chatId) {
  const completed = db.prepare(`
    SELECT COUNT(*) as count FROM completed_reminders
    WHERE chat_id = ? AND julianday('now') - julianday(completed_at) <= 7
  `).get(chatId)?.count || 0;

  const snoozed = db.prepare(`
    SELECT COUNT(*) as count FROM reminders
    WHERE chat_id = ? AND snooze_count > 0 AND julianday('now') - julianday(created_at) <= 7
  `).get(chatId)?.count || 0;

  const missed = db.prepare(`
    SELECT COUNT(*) as count FROM reminders
    WHERE chat_id = ? AND active = 0 AND ignored_since IS NOT NULL AND julianday('now') - julianday(created_at) <= 7
  `).get(chatId)?.count || 0;

  return { completed, snoozed, missed };
}

export function getActiveReminders(chatId) {
  return db.prepare(
    'SELECT * FROM reminders WHERE chat_id = ? AND active = 1 ORDER BY remind_at ASC'
  ).all(chatId);
}

export function getAllActiveReminders() {
  return db.prepare('SELECT * FROM reminders WHERE active = 1').all();
}

export function deactivateReminder(id) {
  db.prepare('UPDATE reminders SET active = 0 WHERE id = ?').run(id);
}

export function snoozeReminder(id, newTime) {
  db.prepare('UPDATE reminders SET remind_at = ?, snoozed_until = ? WHERE id = ?')
    .run(newTime, newTime, id);
}

export function updateReminderTime(id, newTime) {
  db.prepare('UPDATE reminders SET remind_at = ? WHERE id = ?').run(newTime, id);
}

// Settings CRUD

export function getSettings(chatId) {
  let settings = db.prepare('SELECT * FROM settings WHERE chat_id = ?').get(chatId);
  if (!settings) {
    db.prepare('INSERT INTO settings (chat_id) VALUES (?)').run(chatId);
    settings = { chat_id: chatId, timezone: 'UTC', daily_digest: 0, digest_time: '08:00' };
  }
  return settings;
}

export function setTimezone(chatId, timezone) {
  getSettings(chatId); // ensure row exists
  db.prepare('UPDATE settings SET timezone = ? WHERE chat_id = ?').run(timezone, chatId);
}

export function setDailyDigest(chatId, enabled, time) {
  getSettings(chatId);
  const stmt = db.prepare('UPDATE settings SET daily_digest = ?, digest_time = ? WHERE chat_id = ?');
  stmt.run(enabled ? 1 : 0, time || '08:00', chatId);
}

export function getTodaysReminders(chatId, dateStr) {
  return db.prepare(`
    SELECT * FROM reminders
    WHERE chat_id = ? AND active = 1 AND date(remind_at) = ?
    ORDER BY remind_at ASC
  `).all(chatId, dateStr);
}

export function deactivateTodaysReminders(chatId, dateStr) {
  const result = db.prepare(`
    UPDATE reminders SET active = 0
    WHERE chat_id = ? AND active = 1 AND cron_expr IS NULL AND date(remind_at) = ?
  `).run(chatId, dateStr);
  return result.changes;
}

export function deactivateAllReminders(chatId) {
  const result = db.prepare('UPDATE reminders SET active = 0 WHERE chat_id = ? AND active = 1').run(chatId);
  return result.changes;
}

export function pauseAllReminders(chatId) {
  const result = db.prepare('UPDATE reminders SET active = 2 WHERE chat_id = ? AND active = 1').run(chatId);
  return result.changes;
}

export function resumeAllReminders(chatId) {
  const result = db.prepare('UPDATE reminders SET active = 1 WHERE chat_id = ? AND active = 2').run(chatId);
  return result.changes;
}

export function getPausedReminders(chatId) {
  return db.prepare('SELECT * FROM reminders WHERE chat_id = ? AND active = 2 ORDER BY remind_at ASC').all(chatId);
}

export function updateReminderText(id, newText) {
  db.prepare('UPDATE reminders SET text = ? WHERE id = ?').run(newText, id);
}

export function addNoteToReminder(id, note) {
  const existing = db.prepare('SELECT notes FROM reminders WHERE id = ?').get(id);
  const current = existing?.notes || '';
  const updated = current ? `${current}\n${note}` : note;
  db.prepare('UPDATE reminders SET notes = ? WHERE id = ?').run(updated, id);
}

export function attachMedia(id, mediaType, mediaId) {
  db.prepare('UPDATE reminders SET media_type = ?, media_id = ? WHERE id = ?').run(mediaType, mediaId, id);
}

export function getLastReminder(chatId) {
  return db.prepare(
    'SELECT * FROM reminders WHERE chat_id = ? AND active = 1 ORDER BY rowid DESC LIMIT 1'
  ).get(chatId);
}

// Snooze tracking

export function incrementSnoozeCount(id) {
  db.prepare('UPDATE reminders SET snooze_count = snooze_count + 1 WHERE id = ?').run(id);
}

export function getSnoozeCount(id) {
  const row = db.prepare('SELECT snooze_count FROM reminders WHERE id = ?').get(id);
  return row?.snooze_count || 0;
}

export function resetSnoozeCount(id) {
  db.prepare('UPDATE reminders SET snooze_count = 0, ignored_since = NULL WHERE id = ?').run(id);
}

// Fired / ignored tracking

export function markReminderFired(id) {
  db.prepare(`
    UPDATE reminders SET last_fired_at = datetime('now'),
    ignored_since = COALESCE(ignored_since, datetime('now'))
    WHERE id = ?
  `).run(id);
}

export function clearIgnoredSince(id) {
  db.prepare('UPDATE reminders SET ignored_since = NULL WHERE id = ?').run(id);
}

export function getIgnoredReminders(chatId) {
  return db.prepare(`
    SELECT * FROM reminders
    WHERE chat_id = ? AND active = 1 AND ignored_since IS NOT NULL
    AND julianday('now') - julianday(ignored_since) >= 3
  `).all(chatId);
}

// Completed reminders (for pattern detection)

export function logCompletedReminder({ chatId, text, remindAt }) {
  const d = new Date(remindAt);
  db.prepare(`
    INSERT INTO completed_reminders (chat_id, text, original_remind_at, day_of_week, hour, minute)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(chatId, text, remindAt, d.getDay(), d.getHours(), d.getMinutes());
}

export function getCompletedReminders(chatId, daysBack = 28) {
  return db.prepare(`
    SELECT * FROM completed_reminders
    WHERE chat_id = ? AND julianday('now') - julianday(completed_at) <= ?
    ORDER BY completed_at DESC
  `).all(chatId, daysBack);
}

export default db;
