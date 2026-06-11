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
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status >= 500) && i < retries - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
        continue;
      }
      console.error(`[Thoughts] ingest ${res.status}:`, await res.text().catch(() => ''));
      return null;
    } catch (err) {
      if (i < retries - 1) { await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000)); continue; }
      console.error('[Thoughts] forward failed:', err.message);
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
