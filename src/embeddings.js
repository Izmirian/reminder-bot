/**
 * Voyage AI embeddings client — used for semantic chat-history recall.
 * Returns null (never throws) when unconfigured or on any failure, so
 * callers can treat a missing embedding as "feature inert for this call."
 */
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3-lite'; // 512-dim, cheapest tier — sufficient for personal-scale recall
const DIMS = 512;
// Two timeouts for two very different failure economics:
// - READ path (src/ai.js classifyIntent, before the Anthropic call): blocking,
//   the user is waiting on the reply. Kept tight — retrieval must never
//   meaningfully delay a response.
// - WRITE path (src/db.js embedAndStoreMessage, fire-and-forget from
//   addChatMessage): non-blocking, no one is waiting. Gets the original,
//   more generous headroom so a transient blip has a real chance to succeed.
const READ_TIMEOUT_MS = 3000;
const WRITE_TIMEOUT_MS = 10000;

// Circuit breaker — independent of ai.js's aiAvailable/lastFailure, which
// gates the Anthropic API. Voyage and Anthropic are separate external
// services with separate failure modes and must not share state: an Anthropic
// outage shouldn't disable embeddings, and a Voyage outage shouldn't disable
// intent classification.
let voyageAvailable = true;
let voyageLastFailure = 0;
const VOYAGE_COOLDOWN_MS = 10_000;

// Trip the breaker and log once on the closed→open transition, not on every
// subsequent call while it's already open — keeps a sustained outage from
// spamming one log line per message.
function recordFailure(reason) {
  if (voyageAvailable) console.error('[Embeddings]', reason);
  voyageAvailable = false;
  voyageLastFailure = Date.now();
}

// `blocking` (default true) selects the read-path behavior: a tight timeout
// and breaker-gating (an already-open breaker short-circuits with no network
// call). Pass `{ blocking: false }` for fire-and-forget write-path calls —
// they still get the longer timeout and still record failures (so a
// misbehaving Voyage still trips the breaker for the next read-path call),
// they just aren't gated by a breaker a prior read-path failure already opened.
export async function embedText(text, { blocking = true } = {}) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || !text) return null;

  if (blocking && !voyageAvailable) {
    if (Date.now() - voyageLastFailure < VOYAGE_COOLDOWN_MS) return null;
    voyageAvailable = true; // cooldown elapsed — retry
  }

  const timeout = blocking ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;

  try {
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: [text], model: MODEL }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      recordFailure(`Voyage API error: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const v = data.data?.[0]?.embedding;
    if (!Array.isArray(v) || v.length !== DIMS) {
      recordFailure('unexpected response shape');
      return null;
    }
    return v;
  } catch (e) {
    recordFailure(`embedText failed: ${e.message}`);
    return null;
  }
}
