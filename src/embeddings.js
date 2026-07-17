/**
 * Voyage AI embeddings client — used for semantic chat-history recall.
 * Returns null (never throws) when unconfigured or on any failure, so
 * callers can treat a missing embedding as "feature inert for this call."
 */
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3-lite'; // 512-dim, cheapest tier — sufficient for personal-scale recall
const TIMEOUT_MS = 10000;

export async function embedText(text) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || !text) return null;
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
      return null;
    }
    const data = await res.json();
    return data.data?.[0]?.embedding || null;
  } catch (e) {
    console.error('[Embeddings] embedText failed:', e.message);
    return null;
  }
}
