/**
 * Voyage AI embeddings client — used for semantic chat-history recall.
 * Returns null (never throws) when unconfigured or on any failure, so
 * callers can treat a missing embedding as "feature inert for this call."
 */
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3-lite'; // 512-dim, cheapest tier — sufficient for personal-scale recall
// Lowered from 10s: retrieval sits on the critical path of every non-simple
// message (see src/ai.js classifyIntent), and the design intent is that it
// should never meaningfully delay a reply. 3s is generous for an embedding
// call under normal conditions but caps the worst-case added latency.
const TIMEOUT_MS = 3000;

// Circuit breaker — independent of ai.js's aiAvailable/lastFailure, which
// gates the Anthropic API. Voyage and Anthropic are separate external
// services with separate failure modes and must not share state: an Anthropic
// outage shouldn't disable embeddings, and a Voyage outage shouldn't disable
// intent classification.
let voyageAvailable = true;
let voyageLastFailure = 0;
const VOYAGE_COOLDOWN_MS = 10_000;

export async function embedText(text) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || !text) return null;

  if (!voyageAvailable) {
    if (Date.now() - voyageLastFailure < VOYAGE_COOLDOWN_MS) return null;
    voyageAvailable = true; // cooldown elapsed — retry
  }

  try {
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: [text], model: MODEL }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[Embeddings] Voyage API error: ${res.status}`);
      voyageAvailable = false;
      voyageLastFailure = Date.now();
      return null;
    }
    const data = await res.json();
    return data.data?.[0]?.embedding || null;
  } catch (e) {
    console.error('[Embeddings] embedText failed:', e.message);
    voyageAvailable = false;
    voyageLastFailure = Date.now();
    return null;
  }
}
