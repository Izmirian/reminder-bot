/**
 * One-time (idempotent) backfill: push existing journal + memory entries into the
 * Thoughts idea graph. Safe to re-run — the Thoughts service dedupes on
 * (chat_id, source, source_ref), so already-sent rows are skipped.
 *
 *   THOUGHTS_INGEST_URL=... THOUGHTS_INGEST_SECRET=... DATABASE_URL=... \
 *     node scripts/backfill-thoughts.js
 */
import 'dotenv/config';
import pg from 'pg';
import { forwardToThoughts, thoughtsEnabled } from '../src/thoughts-forward.js';

async function main() {
  if (!thoughtsEnabled()) {
    console.error('Set THOUGHTS_INGEST_URL and THOUGHTS_INGEST_SECRET first.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('Backfill reads production data — set DATABASE_URL.');
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false,
  });

  const journals = (await pool.query('SELECT chat_id, id, entry AS text FROM journal ORDER BY id')).rows;
  const memories = (await pool.query('SELECT chat_id, id, fact AS text FROM memory ORDER BY id')).rows;
  const pins = (await pool.query('SELECT chat_id, id, content AS text FROM pins ORDER BY id')).rows;

  let sent = 0, created = 0;
  for (const [source, rows] of [['journal', journals], ['memory', memories], ['pin', pins]]) {
    for (const row of rows) {
      if (!row.text) continue;
      const r = await forwardToThoughts({
        chatId: row.chat_id, text: row.text, source, sourceType: 'text', sourceRef: String(row.id),
      });
      sent++; if (r?.created) created++;
    }
  }

  // Contacts become person hub-nodes (entities, not ideas) — idempotent upsert.
  const contacts = (await pool.query('SELECT chat_id, name FROM contacts ORDER BY id')).rows;
  const { seedThoughtsEntity } = await import('../src/thoughts-forward.js');
  for (const c of contacts) {
    if (c.name) { seedThoughtsEntity(c.chat_id, c.name, 'person'); sent++; }
  }
  await new Promise(r => setTimeout(r, 3000)); // let fire-and-forget seeds flush

  console.log(`[Backfill] Forwarded ${sent} entries (${created} newly created ideas; entity seeds are idempotent).`);
  await pool.end();
  process.exit(0);
}

main().catch(e => { console.error('[Backfill] fatal:', e); process.exit(1); });
