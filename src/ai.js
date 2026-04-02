/**
 * Claude API integration for smart reminder parsing.
 * Falls back gracefully if no API key is set or API is unavailable.
 */

let client = null;
let aiAvailable = true;
let lastFailure = 0;
const COOLDOWN_MS = 60_000;

let initPromise = null;
async function ensureClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (client) return client;

  if (!initPromise) {
    initPromise = import('@anthropic-ai/sdk').then(mod => {
      const Anthropic = mod.default;
      client = new Anthropic();
      return client;
    }).catch(() => null);
  }
  return initPromise;
}

const SYSTEM_PROMPT = `You are a reminder parser. Given a user's message, extract a structured reminder.

Return ONLY a JSON object with these fields:
- "text": The cleaned reminder text (what to remind about)
- "remindAt": ISO 8601 datetime string for when to remind (use the provided timezone)
- "cronExpr": 5-field cron expression if recurring, or null for one-off
- "category": One of "health", "work", "personal", or null
- "needsInfo": If you can't determine the time, set this to a short clarifying question. Set remindAt to null in this case.

Time context mappings:
- "after lunch" = 1:00 PM
- "after work" = 6:00 PM
- "morning" = 9:00 AM
- "evening" = 7:00 PM
- "tonight" = 9:00 PM
- "end of day" = 5:00 PM
- "later" = 2 hours from now

Category detection:
- health: medicine, doctor, gym, vitamins, dentist, workout, meds, pills, hospital
- work: meeting, email, report, deadline, submit, presentation, call (work context), boss, client
- personal: groceries, buy, pick up, laundry, clean, cook, birthday, gift

Always return valid JSON. No markdown, no explanation, just the JSON object.`;

/**
 * Parse a reminder using Claude AI.
 * Returns { text, remindAt, cronExpr, category, needsInfo } or null.
 */
export async function parseWithAI(userMessage, timezone, currentTime) {
  const api = await ensureClient();
  if (!api) return null;

  // Circuit breaker
  if (!aiAvailable) {
    if (Date.now() - lastFailure < COOLDOWN_MS) return null;
    aiAvailable = true;
  }

  try {
    const response = await api.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Current time: ${currentTime}\nTimezone: ${timezone}\nUser message: "${userMessage}"`,
      }],
    });

    let text = response.content[0]?.text;
    if (!text) return null;

    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    const parsed = JSON.parse(text);
    if (!parsed.text) return null;
    if (!parsed.remindAt && !parsed.needsInfo) return null;

    return parsed;
  } catch (err) {
    console.error('[AI] Parse failed:', err.message);
    aiAvailable = false;
    lastFailure = Date.now();
    return null;
  }
}
