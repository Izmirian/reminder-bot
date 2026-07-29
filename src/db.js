/**
 * Database layer — uses Postgres if DATABASE_URL is set, otherwise falls back to SQLite.
 * All functions are synchronous when using SQLite, async when using Postgres.
 * Since all callers are in async contexts, we export async functions that work with both.
 */
import pg from 'pg';
import { CONFIG } from './config.js';
import { embedText } from './embeddings.js';

const { Pool } = pg;

let pool;
let isPostgres = false;

// SQLite fallback for local dev
let sqliteDb = null;

async function initPostgres() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000, // 30s max per query
  });

  // Prevent crashes from idle connection drops
  pool.on('error', (err) => {
    console.error('[DB] Pool error (connection will be retried):', err.message);
    // Surface to the reliability monitor (best-effort, never throws)
    import('./monitor.js').then(m => m.signalDbError(err.message)).catch(() => {});
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      text TEXT NOT NULL,
      remind_at TEXT,
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
  try { await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS location TEXT`); } catch (e) { console.error('[DB] Migration:', e.message); }

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

  // Lists table (grocery, shopping, todo, etc.)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      list_name TEXT NOT NULL,
      items JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Contacts/people notes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      name TEXT NOT NULL,
      notes TEXT,
      birthday TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Journal entries
  await pool.query(`
    CREATE TABLE IF NOT EXISTS journal (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      entry TEXT NOT NULL,
      mood TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Conversation memory (things the user told the bot to remember)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      fact TEXT NOT NULL,
      category TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Expenses
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      category TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Documents storage
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      filename TEXT,
      description TEXT,
      media_type TEXT,
      media_data BYTEA,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Chat history for conversation context
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Index for fast lookups
  // Performance indexes
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_history_chat_id ON chat_history(chat_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_reminders_chat_active ON reminders(chat_id, active)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_reminders_remind_at ON reminders(remind_at) WHERE active = 1`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_completed_chat_date ON completed_reminders(chat_id, completed_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lists_chat ON lists(chat_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_chat ON contacts(chat_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_expenses_chat_date ON expenses(chat_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_journal_chat_date ON journal(chat_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_chat ON memory(chat_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_followups_chat_status ON followups(chat_id, status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pins_chat ON pins(chat_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_projects_chat ON projects(chat_id, active)`);
    // Partial index for getNoTimeReminders (chat_id = ? AND active = 1 AND remind_at IS NULL) —
    // hit on every reminder fire + list/dashboard views.
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_reminders_notime ON reminders(chat_id) WHERE active = 1 AND remind_at IS NULL`);
    // Expression partial index for getMissedReminders, the most frequent query (every 2 min, both platforms).
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_reminders_missed ON reminders((remind_at::timestamptz)) WHERE active = 1 AND cron_expr IS NULL AND last_fired_at IS NULL`);
  } catch (e) { console.error('[DB] Index creation error:', e.message); }

  // Projects table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Pinned messages
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pins (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Follow-ups (people you're waiting on)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS followups (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      person TEXT NOT NULL,
      subject TEXT NOT NULL,
      follow_up_at TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Last action log (for universal undo)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS action_log (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_data JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add project_id to reminders
  try { await pool.query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS project_id INTEGER`); } catch (e) { console.error('[DB] Migration:', e.message); }

  // Recurring expenses table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recurring_expenses (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      category TEXT,
      currency TEXT DEFAULT 'JOD',
      cron_day INTEGER NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add currency to expenses
  try { await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'JOD'`); } catch (e) { console.error('[DB] Migration:', e.message); }

  // Migrations — best-effort, tolerate missing/already-applied columns. Each
  // statement is caught independently (via `migrate`) so one failing statement
  // (e.g. a bad ordering, or an unsupported extension) can't silently abort
  // every migration after it in the list — a real bug that hit this exact
  // block earlier in this branch's history (see the google_tokens comment
  // below). The generic catch-and-continue is intentional here: these are all
  // "nice to have if possible" schema tweaks, not required for boot.
  const migrate = async (sql) => {
    try {
      await pool.query(sql);
    } catch (e) {
      console.error('[DB] Migration failed:', sql.trim().slice(0, 80), '—', e.message);
    }
  };
  await migrate(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS media_data BYTEA`);
  await migrate(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal'`);
  await migrate(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS fire_count INTEGER DEFAULT 0`);
  await migrate(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS shared_with TEXT`);
  await migrate(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS created_by TEXT`);
  await migrate(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS google_event_id TEXT`);
  await migrate(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`);
  // Column must exist before the purge below can reference it — on a fresh
  // database (e.g. CI's ephemeral Postgres) these once ran in the opposite
  // order, so the UPDATE threw "column does not exist" and (before `migrate`
  // existed) silently aborted every migration after it in this block.
  await migrate(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS google_tokens TEXT`);
  // Purge legacy 'null'-string google_tokens (written before the NULL fix) so
  // disconnected users stop being scanned by the calendar sync crons.
  await migrate(`UPDATE settings SET google_tokens = NULL WHERE google_tokens = 'null'`);
  await migrate(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS google_calendar_id TEXT DEFAULT 'primary'`);
  // Quiet hours — "HH:MM" local-time window during which non-urgent reminders are held.
  await migrate(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS quiet_start TEXT`);
  await migrate(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS quiet_end TEXT`);
  // No-time reminders: remind_at NULL = a captured item with no schedule yet.
  await migrate(`ALTER TABLE reminders ALTER COLUMN remind_at DROP NOT NULL`);
  // Semantic chat-memory recall — pgvector extension + embedding column + ANN index.
  // If the extension isn't available on this Postgres instance, this throws and is
  // caught independently; the feature then stays silently disabled (write/read paths
  // already treat a missing column as "return null / []" — see Task 3/4).
  await migrate(`CREATE EXTENSION IF NOT EXISTS vector`);
  await migrate(`ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS embedding vector(512)`);
  await migrate(`CREATE INDEX IF NOT EXISTS idx_chat_history_embedding ON chat_history USING hnsw (embedding vector_cosine_ops)`);

  isPostgres = true;
  console.log('[DB] Connected to Postgres');
}

// Graceful shutdown — close pool
export async function closePool() {
  if (pool) { await pool.end(); console.log('[DB] Pool closed'); }
}

// Lightweight DB health probe for the self-check monitor.
// Returns true if a trivial query succeeds, throws otherwise.
export async function pingDb() {
  if (!isPostgres && !sqliteDb) throw new Error('DB not initialized');
  await query('SELECT 1');
  return true;
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
      remind_at TEXT, cron_expr TEXT, timezone TEXT DEFAULT 'UTC', category TEXT,
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
  // Retry DB connection up to 5 times with backoff
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await initPostgres();
      break;
    } catch (err) {
      console.error(`[DB] Connection attempt ${attempt}/5 failed:`, err.message);
      if (attempt === 5) {
        console.error('[DB] All connection attempts failed. Starting without DB — features will be limited.');
      } else {
        const delay = attempt * 3000; // 3s, 6s, 9s, 12s
        console.log(`[DB] Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
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

// Pure predicate: a reminder can be scheduled only if it has a one-off time or a cron.
// No-time rows (remind_at null/empty, no cron) must be skipped so they never fire-at-epoch.
// Shared by both schedulers (scheduleReminder + load loops) so the guard can't diverge.
export function isSchedulable(reminder) {
  return !!(reminder.remind_at || reminder.cron_expr);
}

// No-time reminder: captured with remind_at NULL. Never scheduled/fired; shown in
// the list and surfaced when other reminders fire, until the user gives it a time.
export async function createNoTimeReminder({ chatId, text, category, priority }) {
  return insert(
    'INSERT INTO reminders (chat_id, text, remind_at, category, priority) VALUES (?, ?, NULL, ?, ?)',
    [chatId, text, category || null, priority || 'normal']
  );
}

export async function getNoTimeReminders(chatId) {
  return (await query('SELECT * FROM reminders WHERE chat_id = ? AND active = 1 AND remind_at IS NULL ORDER BY created_at DESC', [chatId])).rows;
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
  // Clear cancelled_at so a re-activated reminder doesn't double-count
  // as both "active" and "cancelled" in the activity newsletter.
  await run('UPDATE reminders SET active = 1, cancelled_at = NULL WHERE id = ?', [id]);
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
  // (remind_at IS NULL) sorts no-time rows last in BOTH Postgres and SQLite; id ASC
  // gives a stable order within the no-time bucket so letter IDs don't drift between views.
  return (await query('SELECT * FROM reminders WHERE chat_id = ? AND active = 1 ORDER BY (remind_at IS NULL), remind_at ASC, id ASC', [chatId])).rows;
}

export async function getAllActiveReminders() {
  return (await query('SELECT * FROM reminders WHERE active = 1')).rows;
}

// Distinct active chat_ids only — for cron jobs that fan out per user. Avoids
// SELECT *-ing every reminder (incl. media_data BYTEA) just to derive the user list.
export async function getActiveChatIds() {
  return (await query('SELECT DISTINCT chat_id FROM reminders WHERE active = 1')).rows.map(r => r.chat_id);
}

export async function deactivateReminder(id) {
  await run('UPDATE reminders SET active = 0 WHERE id = ?', [id]);
}

// Marks a reminder as user-cancelled (sets active=0 AND timestamps the cancellation).
// Used for the daily/weekly newsletter to distinguish cancellations from completions.
export async function markReminderCancelled(id) {
  await run('UPDATE reminders SET active = 0, cancelled_at = NOW() WHERE id = ?', [id]);
}

// Returns reminders added/completed/cancelled within a time window for the daily/weekly newsletter.
export async function getActivitySummary(chatId, sinceISO) {
  const added = (await query(
    'SELECT id, text, remind_at, created_at FROM reminders WHERE chat_id = ? AND created_at >= ?::timestamptz ORDER BY created_at DESC',
    [chatId, sinceISO]
  )).rows;
  const completed = (await query(
    'SELECT text, completed_at, original_remind_at FROM completed_reminders WHERE chat_id = ? AND completed_at >= ?::timestamptz ORDER BY completed_at DESC',
    [chatId, sinceISO]
  )).rows;
  const cancelled = (await query(
    'SELECT id, text, remind_at, cancelled_at FROM reminders WHERE chat_id = ? AND cancelled_at >= ?::timestamptz ORDER BY cancelled_at DESC',
    [chatId, sinceISO]
  )).rows;
  return { added, completed, cancelled };
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

export async function setGoogleTokens(chatId, tokens) {
  await getSettings(chatId);
  // Pass real SQL NULL when clearing — JSON.stringify(null) is the string 'null',
  // which is NOT SQL NULL and would keep the user in getUsersWithGoogleTokens forever.
  await run('UPDATE settings SET google_tokens = ? WHERE chat_id = ?', [tokens ? JSON.stringify(tokens) : null, chatId]);
}

export async function getGoogleTokens(chatId) {
  const settings = await getSettings(chatId);
  // Guard against the legacy 'null' string poison written before the fix above.
  if (!settings.google_tokens || settings.google_tokens === 'null') return null;
  return JSON.parse(settings.google_tokens);
}

export async function setGoogleEventId(reminderId, eventId) {
  await run('UPDATE reminders SET google_event_id = ? WHERE id = ?', [eventId, reminderId]);
}

export async function getUsersWithGoogleTokens() {
  return (await query("SELECT * FROM settings WHERE google_tokens IS NOT NULL AND google_tokens <> 'null'")).rows;
}

export async function setLocation(chatId, location) {
  await getSettings(chatId);
  await run('UPDATE settings SET location = ? WHERE chat_id = ?', [location, chatId]);
}

// Quiet hours: pass "HH:MM" strings, or (null, null) to disable.
export async function setQuietHours(chatId, start, end) {
  await getSettings(chatId);
  await run('UPDATE settings SET quiet_start = ?, quiet_end = ? WHERE chat_id = ?', [start, end, chatId]);
}

// Get users whose digest is due at a specific time (efficient — no full table scan)
export async function getDigestUsers(digestTime) {
  return (await query('SELECT chat_id FROM settings WHERE daily_digest = 1 AND digest_time = ?', [digestTime])).rows;
}

export async function setDailyDigest(chatId, enabled, time) {
  await getSettings(chatId);
  await run('UPDATE settings SET daily_digest = ?, digest_time = ? WHERE chat_id = ?', [enabled ? 1 : 0, time || '08:00', chatId]);
}

export async function getTodaysReminders(chatId, dateStr) {
  return (await query("SELECT * FROM reminders WHERE chat_id = ? AND active = 1 AND remind_at::date = ?::date ORDER BY remind_at ASC", [chatId, dateStr])).rows;
}

export async function deactivateTodaysReminders(chatId, dateStr) {
  const result = await run("UPDATE reminders SET active = 0, cancelled_at = NOW() WHERE chat_id = ? AND active = 1 AND cron_expr IS NULL AND remind_at::date = ?::date", [chatId, dateStr]);
  return result.changes;
}

// Find active one-off reminders that are past due and were never fired
export async function getMissedReminders() {
  return (await query(
    "SELECT * FROM reminders WHERE active = 1 AND cron_expr IS NULL AND remind_at::timestamptz < NOW() AND last_fired_at IS NULL"
  )).rows;
}

export async function deactivateAllReminders(chatId) {
  const result = await run('UPDATE reminders SET active = 0, cancelled_at = NOW() WHERE chat_id = ? AND active = 1', [chatId]);
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
  await run("UPDATE reminders SET last_fired_at = NOW()::text, ignored_since = COALESCE(ignored_since, NOW()::text) WHERE id = ?", [id]);
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
  // No-time reminders have remindAt = null. new Date(null) is the 1970 epoch,
  // which would write garbage day/hour/minute and pollute pattern detection.
  const d = remindAt ? new Date(remindAt) : null;
  const valid = d && !isNaN(d.getTime());
  await insert(
    'INSERT INTO completed_reminders (chat_id, text, original_remind_at, day_of_week, hour, minute) VALUES (?, ?, ?, ?, ?, ?)',
    [chatId, text, remindAt || null, valid ? d.getDay() : null, valid ? d.getHours() : null, valid ? d.getMinutes() : null]
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

export async function deactivateMonitor(id, chatId) {
  if (chatId) {
    await run('UPDATE url_monitors SET active = 0 WHERE id = ? AND chat_id = ?', [id, chatId]);
  } else {
    await run('UPDATE url_monitors SET active = 0 WHERE id = ?', [id]);
  }
}

// --- Documents ---

export async function saveDocument(chatId, filename, description, mediaType, mediaData) {
  const id = await insert('INSERT INTO documents (chat_id, filename, description, media_type, media_data) VALUES (?, ?, ?, ?, ?)',
    [chatId, filename, description || null, mediaType || null, mediaData || null]);
  // Saved documents become idea-graph nodes: Thoughts analyzes the content
  // (Claude vision/PDF) into embeddable text. Fire-and-forget; no-op if unconfigured.
  try {
    const { forwardToThoughtsAsync } = await import('./thoughts-forward.js');
    const isPdf = (mediaType || '').includes('pdf');
    forwardToThoughtsAsync({
      chatId,
      text: [filename, description].filter(Boolean).join(' — '),
      mediaBuffer: mediaData || null,
      mediaMime: mediaType || null,
      source: 'document',
      sourceType: mediaData ? (isPdf ? 'document' : 'image') : 'text',
      sourceRef: String(id),
    });
  } catch {}
  return id;
}

export async function getDocuments(chatId) {
  return (await query('SELECT id, chat_id, filename, description, media_type, created_at FROM documents WHERE chat_id = ? ORDER BY created_at DESC LIMIT 20', [chatId])).rows;
}

export async function getDocument(chatId, id) {
  return queryOne('SELECT * FROM documents WHERE chat_id = ? AND id = ?', [chatId, id]);
}

export async function searchDocuments(chatId, searchQuery) {
  return (await query('SELECT id, filename, description, media_type, created_at FROM documents WHERE chat_id = ? AND (filename ILIKE ? OR description ILIKE ?) ORDER BY created_at DESC LIMIT 10',
    [chatId, `%${searchQuery}%`, `%${searchQuery}%`])).rows;
}

// --- Cleanup ---

// Auto-deactivate one-off reminders older than 30 days that were never completed
export async function cleanupStaleReminders() {
  const result = await run(
    "UPDATE reminders SET active = 0 WHERE active = 1 AND cron_expr IS NULL AND remind_at::timestamptz < NOW() - INTERVAL '30 days'"
  );
  return result.changes || 0;
}

// Delete deactivated reminders older than 90 days
export async function purgeOldReminders() {
  const result = await run(
    "DELETE FROM reminders WHERE active = 0 AND created_at < NOW() - INTERVAL '90 days'"
  );
  return result.changes || 0;
}

// Delete completed reminders older than 6 months
export async function purgeOldCompletedReminders() {
  const result = await run(
    "DELETE FROM completed_reminders WHERE completed_at < NOW() - INTERVAL '180 days'"
  );
  return result.changes || 0;
}

// Delete chat history older than PURGE_CHAT_HISTORY_DAYS (60) — the real retention
// mechanism for chat memory; addChatMessage's own prune is just a safety cap.
export async function purgeOldChatHistory() {
  const result = await run(
    `DELETE FROM chat_history WHERE created_at < NOW() - INTERVAL '${CONFIG.PURGE_CHAT_HISTORY_DAYS} days'`
  );
  return result.changes || 0;
}

// Delete old expenses older than 1 year
export async function purgeOldExpenses() {
  const result = await run(
    "DELETE FROM expenses WHERE created_at < NOW() - INTERVAL '365 days'"
  );
  return result.changes || 0;
}

// --- Chat History ---

export async function addChatMessage(chatId, role, content) {
  const trimmed = content.substring(0, 2000); // Cap at 2000 chars per message
  const id = await insert('INSERT INTO chat_history (chat_id, role, content) VALUES (?, ?, ?)',
    [chatId, role, trimmed]);
  // Safety-cap prune — the real retention mechanism is the 60-day purge cron
  // (purgeOldChatHistory). This just bounds worst-case table growth.
  await run(
    `DELETE FROM chat_history WHERE chat_id = ? AND id NOT IN (SELECT id FROM chat_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT ${CONFIG.CHAT_HISTORY_SAFETY_CAP})`,
    [chatId, chatId]
  );
  // Best-effort embed — fire-and-forget so a slow/failed Voyage call never
  // blocks or fails the surrounding chat flow.
  if (isPostgres && id) {
    embedAndStoreMessage(id, trimmed).catch((e) => console.error('[DB] Embed-write failed:', e.message));
  }
  return id;
}

// Write an already-computed embedding to a chat_history row. Split out from
// embedAndStoreMessage so schema/cast behavior is testable with a synthetic
// vector, independent of a live Voyage call.
export async function storeEmbedding(id, embedding) {
  const vectorLiteral = `[${embedding.join(',')}]`;
  await run('UPDATE chat_history SET embedding = ?::vector WHERE id = ?', [vectorLiteral, id]);
}

// Embed a message's content via Voyage and store it. Returns false (never
// throws) if embeddings are unconfigured/unavailable — callers treat that as
// "this row just has no embedding," not an error.
export async function embedAndStoreMessage(id, content) {
  const embedding = await embedText(content, { blocking: false });
  if (!embedding) return false;
  await storeEmbedding(id, embedding);
  return true;
}

// Pure — pgvector's <=> operator (with vector_cosine_ops) returns cosine
// DISTANCE (1 - similarity), so a similarity threshold must be inverted
// before use in a WHERE clause. Exported for direct unit testing.
export function similarityToDistance(minSimilarity) {
  return 1 - minSimilarity;
}

// Semantic search over a chat's older history. Returns [] (never throws) when
// embeddings are unavailable/unconfigured/non-Postgres — callers treat that as
// "no relevant context found," identical to a genuine zero-match result.
export async function getRelevantHistory(chatId, embedding, opts = {}) {
  if (!isPostgres || !embedding) return [];
  const {
    minSimilarity = CONFIG.CHAT_RECALL_MIN_SIMILARITY,
    limit = CONFIG.CHAT_RECALL_MAX_RESULTS,
    minAgeHours = CONFIG.CHAT_RECALL_MIN_AGE_HOURS,
  } = opts;
  const maxDistance = similarityToDistance(minSimilarity);
  const vectorLiteral = `[${embedding.join(',')}]`;
  try {
    const rows = (await query(
      `SELECT role, content, created_at FROM chat_history
       WHERE chat_id = ? AND embedding IS NOT NULL
         AND created_at > NOW() - INTERVAL '${CONFIG.PURGE_CHAT_HISTORY_DAYS} days'
         AND created_at < NOW() - INTERVAL '1 hour' * ?
         AND (embedding <=> ?::vector) <= ?
       ORDER BY embedding <=> ?::vector
       LIMIT ?`,
      [chatId, minAgeHours, vectorLiteral, maxDistance, vectorLiteral, limit]
    )).rows;
    return rows;
  } catch (e) {
    console.error('[DB] getRelevantHistory failed:', e.message);
    return [];
  }
}

export async function getChatHistory(chatId, limit = 50) {
  // Get last N messages (limit = 50 = 25 exchanges)
  const rows = (await query(
    'SELECT role, content FROM chat_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?',
    [chatId, limit]
  )).rows;
  return rows.reverse(); // Oldest first for conversation order
}

// --- Lists ---

export async function getList(chatId, listName) {
  return queryOne('SELECT * FROM lists WHERE chat_id = ? AND LOWER(list_name) = LOWER(?)', [chatId, listName]);
}

export async function getAllLists(chatId) {
  return (await query('SELECT * FROM lists WHERE chat_id = ? ORDER BY updated_at DESC', [chatId])).rows;
}

export async function upsertListItems(chatId, listName, items) {
  const existing = await getList(chatId, listName);
  if (existing) {
    await run('UPDATE lists SET items = ?, updated_at = NOW() WHERE id = ?', [JSON.stringify(items), existing.id]);
    return existing.id;
  }
  return insert('INSERT INTO lists (chat_id, list_name, items) VALUES (?, ?, ?)', [chatId, listName, JSON.stringify(items)]);
}

export async function deleteList(chatId, listName) {
  await run('DELETE FROM lists WHERE chat_id = ? AND LOWER(list_name) = LOWER(?)', [chatId, listName]);
}

// --- Contacts ---

export async function upsertContact(chatId, name, notes, birthday) {
  const existing = await queryOne('SELECT * FROM contacts WHERE chat_id = ? AND LOWER(name) = LOWER(?)', [chatId, name]);
  if (existing) {
    if (notes) {
      // Append notes instead of overwriting
      const current = existing.notes || '';
      const updated = current ? `${current}\n${notes}` : notes;
      await run('UPDATE contacts SET notes = ? WHERE id = ?', [updated, existing.id]);
    }
    if (birthday) await run('UPDATE contacts SET birthday = ? WHERE id = ?', [birthday, existing.id]);
    return existing.id;
  }
  const id = await insert('INSERT INTO contacts (chat_id, name, notes, birthday) VALUES (?, ?, ?, ?)', [chatId, name, notes || null, birthday || null]);
  // New contacts become person hub-nodes in the idea graph, so enrichment can
  // link ideas that mention them. Fire-and-forget; no-op if unconfigured.
  try {
    const { seedThoughtsEntity } = await import('./thoughts-forward.js');
    seedThoughtsEntity(chatId, name, 'person');
  } catch {}
  return id;
}

export async function getContact(chatId, name) {
  return queryOne('SELECT * FROM contacts WHERE chat_id = ? AND LOWER(name) = LOWER(?)', [chatId, name]);
}

export async function getAllContacts(chatId) {
  return (await query('SELECT * FROM contacts WHERE chat_id = ? ORDER BY name ASC', [chatId])).rows;
}

export async function getUpcomingBirthdays(chatId, daysAhead = 7) {
  // Get contacts with birthdays in the next N days
  return (await query(
    `SELECT * FROM contacts WHERE chat_id = ? AND birthday IS NOT NULL ORDER BY birthday ASC`,
    [chatId]
  )).rows;
}

// --- Journal ---

export async function addJournalEntry(chatId, entry, mood) {
  const id = await insert('INSERT INTO journal (chat_id, entry, mood) VALUES (?, ?, ?)', [chatId, entry, mood || null]);
  try {
    const { forwardToThoughtsAsync } = await import('./thoughts-forward.js');
    forwardToThoughtsAsync({ chatId, text: entry, source: 'journal', sourceType: 'text', sourceRef: String(id) });
  } catch {}
  return id;
}

export async function getJournalEntries(chatId, fromDate, toDate) {
  if (fromDate && toDate) {
    return (await query(
      'SELECT * FROM journal WHERE chat_id = ? AND created_at >= ?::timestamptz AND created_at <= ?::timestamptz ORDER BY created_at DESC LIMIT 20',
      [chatId, fromDate, toDate]
    )).rows;
  }
  return (await query('SELECT * FROM journal WHERE chat_id = ? ORDER BY created_at DESC LIMIT 20', [chatId])).rows;
}

export async function searchJournal(chatId, searchQuery) {
  return (await query('SELECT * FROM journal WHERE chat_id = ? AND entry ILIKE ? ORDER BY created_at DESC LIMIT 20', [chatId, `%${searchQuery}%`])).rows;
}

// --- Memory (conversation facts) ---

export async function addMemory(chatId, fact, category) {
  const id = await insert('INSERT INTO memory (chat_id, fact, category) VALUES (?, ?, ?)', [chatId, fact, category || null]);
  try {
    const { forwardToThoughtsAsync } = await import('./thoughts-forward.js');
    forwardToThoughtsAsync({ chatId, text: fact, source: 'memory', sourceType: 'text', sourceRef: String(id) });
  } catch {}
  return id;
}

export async function getMemories(chatId) {
  return (await query('SELECT * FROM memory WHERE chat_id = ? ORDER BY created_at DESC', [chatId])).rows;
}

export async function searchMemory(chatId, searchQuery) {
  return (await query('SELECT * FROM memory WHERE chat_id = ? AND fact ILIKE ? ORDER BY created_at DESC LIMIT 10', [chatId, `%${searchQuery}%`])).rows;
}

export async function deleteMemory(chatId, id) {
  await run('DELETE FROM memory WHERE chat_id = ? AND id = ?', [chatId, id]);
}

// --- Expenses ---

export async function addExpense(chatId, amount, description, category, currency) {
  return insert('INSERT INTO expenses (chat_id, amount, description, category, currency) VALUES (?, ?, ?, ?, ?)',
    [chatId, amount, description || null, category || null, currency || 'JOD']);
}

// Recurring expenses
export async function createRecurringExpense(chatId, amount, description, category, currency, cronDay) {
  return insert('INSERT INTO recurring_expenses (chat_id, amount, description, category, currency, cron_day) VALUES (?, ?, ?, ?, ?, ?)',
    [chatId, amount, description || null, category || null, currency || 'JOD', cronDay]);
}

export async function getActiveRecurringExpenses() {
  return (await query('SELECT * FROM recurring_expenses WHERE active = 1')).rows;
}

export async function getUserRecurringExpenses(chatId) {
  return (await query('SELECT * FROM recurring_expenses WHERE chat_id = ? AND active = 1 ORDER BY cron_day ASC', [chatId])).rows;
}

export async function deactivateRecurringExpense(chatId, id) {
  await run('DELETE FROM recurring_expenses WHERE chat_id = ? AND id = ?', [chatId, id]);
}

// Expense summary by category (for weekly insights)
export async function getExpensesByCategory(chatId, daysBack = 7) {
  return (await query(
    "SELECT category, currency, SUM(amount) as total, COUNT(*) as count FROM expenses WHERE chat_id = ? AND created_at > NOW() - INTERVAL '1 day' * ? GROUP BY category, currency ORDER BY total DESC",
    [chatId, daysBack]
  )).rows;
}

export async function getExpenses(chatId, daysBack = 7) {
  return (await query(
    "SELECT * FROM expenses WHERE chat_id = ? AND created_at > NOW() - INTERVAL '1 day' * ? ORDER BY created_at DESC",
    [chatId, daysBack]
  )).rows;
}

export async function getExpenseSummary(chatId, daysBack = 7) {
  const row = await queryOne(
    "SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM expenses WHERE chat_id = ? AND created_at > NOW() - INTERVAL '1 day' * ?",
    [chatId, daysBack]
  );
  return { total: Number(row?.total || 0), count: Number(row?.count || 0) };
}

// --- Projects ---

export async function createProject(chatId, name, description) {
  return insert('INSERT INTO projects (chat_id, name, description) VALUES (?, ?, ?)', [chatId, name, description || null]);
}

export async function getProjects(chatId) {
  return (await query('SELECT * FROM projects WHERE chat_id = ? AND active = 1 ORDER BY created_at DESC', [chatId])).rows;
}

export async function getProject(chatId, name) {
  return queryOne('SELECT * FROM projects WHERE chat_id = ? AND LOWER(name) = LOWER(?) AND active = 1', [chatId, name]);
}

export async function assignReminderToProject(reminderId, projectId) {
  await run('UPDATE reminders SET project_id = ? WHERE id = ?', [projectId, reminderId]);
}

export async function getProjectReminders(chatId, projectId) {
  return (await query('SELECT * FROM reminders WHERE chat_id = ? AND project_id = ? AND active = 1 ORDER BY remind_at ASC', [chatId, projectId])).rows;
}

// One grouped query for per-project task counts → Map(project_id → count).
// Avoids the dashboard's N+1 (one getProjectReminders per project just for .length).
export async function getProjectTaskCounts(chatId) {
  const rows = (await query('SELECT project_id, COUNT(*) AS n FROM reminders WHERE chat_id = ? AND active = 1 AND project_id IS NOT NULL GROUP BY project_id', [chatId])).rows;
  const map = new Map();
  for (const r of rows) map.set(Number(r.project_id), Number(r.n));
  return map;
}

export async function archiveProject(chatId, name) {
  await run('UPDATE projects SET active = 0 WHERE chat_id = ? AND LOWER(name) = LOWER(?)', [chatId, name]);
}

// --- Pins ---

export async function addPin(chatId, content, source) {
  return insert('INSERT INTO pins (chat_id, content, source) VALUES (?, ?, ?)', [chatId, content, source || null]);
}

export async function getPins(chatId) {
  return (await query('SELECT * FROM pins WHERE chat_id = ? ORDER BY created_at DESC LIMIT 20', [chatId])).rows;
}

export async function deletePin(chatId, id) {
  await run('DELETE FROM pins WHERE chat_id = ? AND id = ?', [chatId, id]);
}

// --- Follow-ups ---

export async function createFollowup(chatId, person, subject, followUpAt) {
  return insert('INSERT INTO followups (chat_id, person, subject, follow_up_at) VALUES (?, ?, ?, ?)', [chatId, person, subject, followUpAt]);
}

export async function getPendingFollowups(chatId) {
  return (await query("SELECT * FROM followups WHERE chat_id = ? AND status = 'pending' ORDER BY follow_up_at ASC", [chatId])).rows;
}

export async function getDueFollowups(chatId) {
  return (await query("SELECT * FROM followups WHERE chat_id = ? AND status = 'pending' AND follow_up_at::timestamptz <= NOW()", [chatId])).rows;
}

export async function completeFollowup(chatId, id) {
  await run("UPDATE followups SET status = 'done' WHERE chat_id = ? AND id = ?", [chatId, id]);
}

// --- Action Log (universal undo) ---

export async function logAction(chatId, actionType, actionData) {
  await insert('INSERT INTO action_log (chat_id, action_type, action_data) VALUES (?, ?, ?)', [chatId, actionType, JSON.stringify(actionData)]);
  // Keep only last 20 actions per chat
  await run('DELETE FROM action_log WHERE chat_id = ? AND id NOT IN (SELECT id FROM action_log WHERE chat_id = ? ORDER BY created_at DESC LIMIT 20)', [chatId, chatId]);
}

export async function getLastAction(chatId) {
  return queryOne('SELECT * FROM action_log WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1', [chatId]);
}

export async function deleteLastAction(chatId) {
  const last = await getLastAction(chatId);
  if (last) await run('DELETE FROM action_log WHERE id = ?', [last.id]);
  return last;
}

// --- Conflict detection ---

export async function getRemindersNear(chatId, time, windowMinutes = 30) {
  const before = new Date(new Date(time).getTime() - windowMinutes * 60000).toISOString();
  const after = new Date(new Date(time).getTime() + windowMinutes * 60000).toISOString();
  return (await query('SELECT * FROM reminders WHERE chat_id = ? AND active = 1 AND remind_at >= ? AND remind_at <= ?', [chatId, before, after])).rows;
}

// --- Last message timestamp (for idle check-in) ---

export async function getLastMessageTime(chatId) {
  const row = await queryOne('SELECT created_at FROM chat_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1', [chatId]);
  return row?.created_at || null;
}
