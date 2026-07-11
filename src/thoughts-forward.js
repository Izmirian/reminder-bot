/**
 * Forwards captured ideas (and journal/memory notes) to the Thoughts idea-graph
 * service. No-op if THOUGHTS_INGEST_URL / THOUGHTS_INGEST_SECRET are unset, so the
 * bot keeps working standalone.
 */

const INGEST_URL = process.env.THOUGHTS_INGEST_URL;
const INGEST_SECRET = process.env.THOUGHTS_INGEST_SECRET;

// Only forward ideas from these chat ids. Defaults to the owner's own number
// (WHATSAPP_TO_NUMBER) so that a stranger texting the business number can't inject
// content into the personal idea graph (and thus can't reach the viewer at all).
// Set THOUGHTS_ALLOWED_CHATS (comma-separated) to allow more; leave both unset to
// forward from everyone (open deployment).
const ALLOWED_CHATS = (process.env.THOUGHTS_ALLOWED_CHATS || process.env.WHATSAPP_TO_NUMBER || '')
  .split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);

export function thoughtsEnabled() {
  return !!(INGEST_URL && INGEST_SECRET);
}

/** Whether a chat id is allowed to feed the idea graph. */
export function chatAllowed(chatId) {
  if (!ALLOWED_CHATS.length) return true; // no allowlist configured
  return ALLOWED_CHATS.includes(String(chatId).replace(/\D/g, ''));
}

/**
 * Detect an explicit thought-capture prefix ("idea:", "thought:", "note:", or a
 * leading "#"). Returns the cleaned text, or null.
 */
export function extractIdeaPrefix(text) {
  const t = (text || '').trim();
  const m = t.match(/^(?:idea|thought|note)\s*:\s*([\s\S]+)/i);
  if (m) return m[1].trim();
  if (t.startsWith('#') && t.length > 1) return t.slice(1).trim();
  return null;
}

/**
 * Build the unmistakable WhatsApp confirmation for a captured thought. A thought is
 * always pinned (durable, so it's never missed) and, when configured, added to the
 * idea graph. Deliberately distinct from the reminder confirmation ("✅ Reminder
 * set! … ⏰ <time>") so the two buckets can never be confused.
 *   { pinned: bool, graph: ingestResult|null, graphConfigured: bool }
 */
export function thoughtReply({ pinned, graph, graphConfigured }) {
  const linked = graph?.ok && graph.linkedCount > 0
    ? ` — linked to ${graph.linkedCount} related thought${graph.linkedCount > 1 ? 's' : ''}`
    : '';
  if (pinned && graph?.ok) return `📌 Pinned & added to your idea graph${linked}.`;
  if (pinned && graphConfigured) return `📌 Pinned. (Idea graph unreachable right now — it'll catch up.)`;
  if (pinned) return `📌 Pinned to your thoughts.`;
  if (graph?.ok) return `🧠 Added to your idea graph${linked}.`;
  return `⚠️ Couldn't save that — please resend.`;
}

/**
 * Send one item to the Thoughts service.
 * @param {object} p
 * @param {string} p.chatId
 * @param {string} [p.text]            - text content / caption
 * @param {Buffer} [p.mediaBuffer]     - optional media bytes (image/audio/pdf)
 * @param {string} [p.mediaMime]
 * @param {string} [p.source]          - whatsapp | journal | memory
 * @param {string} [p.sourceType]      - text | image | audio | document
 * @param {string} [p.sourceRef]       - external id for idempotent backfill
 * @returns {Promise<object|null>} ingest result ({ ok, id, linkedCount, ... }) or null
 */
// Forwarding health, kept in memory for the /health endpoint: timestamps + last
// HTTP code only — never message content or the ingest URL.
const forwardStats = { lastOkAt: null, lastErrorAt: null, lastErrorCode: null };

export function getForwardStats() {
  return { ...forwardStats };
}

function recordForwardResult(ok, code = null) {
  if (ok) forwardStats.lastOkAt = new Date().toISOString();
  else { forwardStats.lastErrorAt = new Date().toISOString(); forwardStats.lastErrorCode = code; }
}

export async function forwardToThoughts({ chatId, text = null, mediaBuffer = null, mediaMime = null,
  source = 'whatsapp', sourceType = 'text', sourceRef = null }, retries = 3) {
  if (!thoughtsEnabled()) return null;
  if (!chatAllowed(chatId)) return null; // ignore non-owner senders

  const body = {
    chatId, text, source, sourceType, sourceRef,
    mediaMime: mediaBuffer ? mediaMime : undefined,
    mediaBase64: mediaBuffer ? Buffer.from(mediaBuffer).toString('base64') : undefined,
  };

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${INGEST_URL.replace(/\/$/, '')}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ingest-secret': INGEST_SECRET },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) { recordForwardResult(true); return res.json(); }
      if ((res.status === 429 || res.status >= 500) && i < retries - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
        continue;
      }
      console.error(`[Thoughts] ingest ${res.status}:`, await res.text().catch(() => ''));
      recordForwardResult(false, res.status);
      return null;
    } catch (err) {
      if (i < retries - 1) { await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000)); continue; }
      console.error('[Thoughts] forward failed:', err.message);
      recordForwardResult(false, 0); // 0 = network/timeout
      return null;
    }
  }
  return null;
}

/** Fire-and-forget variant for hot paths (journal/memory writes). */
export function forwardToThoughtsAsync(payload) {
  if (!thoughtsEnabled()) return;
  forwardToThoughts(payload).catch(e => console.error('[Thoughts] async forward:', e.message));
}
