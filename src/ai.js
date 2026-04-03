/**
 * Claude AI integration — intent classification and smart reminder parsing.
 * Every message goes through Claude to understand what the user wants.
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

const INTENT_PROMPT = `You are a smart assistant inside a reminder bot. Your job is to understand the user's intent and respond appropriately.

Classify the message into one of these intents and return a JSON object:

1. **"reminder"** — The user wants to set one or more reminders.
   Return: { "intent": "reminder", "reminders": [{ "text": "...", "remindAt": "ISO8601", "cronExpr": "cron or null", "category": "health|work|personal|null" }] }
   - If the message contains MULTIPLE reminders (e.g., "remind me to call mom at 3pm and buy groceries at 5pm"), return multiple items in the array.
   - If you can't determine the time, return: { "intent": "reminder", "needsInfo": "What time should I remind you?" }

2. **"chat"** — The user is just chatting, greeting, asking a question, or making conversation.
   Return: { "intent": "chat", "reply": "Your friendly response here" }
   - Be warm, friendly, and natural. You're a helpful bot with personality.
   - For greetings: respond warmly and mention you can help with reminders.
   - For questions about you: explain you're a reminder bot.
   - For general questions: give a brief answer and mention you're mainly a reminder bot.
   - Keep replies short (1-3 sentences).

3. **"command"** — The user wants to perform a bot action (list reminders, cancel, etc.)
   Return: { "intent": "command", "command": "list|cancel|clear_all|clear_today|pause|resume|undo|repeat|summary|timezone|digest|help|menu", "args": "optional args" }

Time context:
- "after lunch" = 1:00 PM, "after work" = 6:00 PM, "morning" = 9:00 AM
- "evening" = 7:00 PM, "tonight" = 9:00 PM, "end of day" = 5:00 PM
- "later" = 2 hours from now

Category detection:
- health: medicine, doctor, gym, vitamins, dentist, workout, meds
- work: meeting, email, report, deadline, submit, presentation, client
- personal: groceries, buy, pick up, laundry, clean, cook, birthday

Return ONLY valid JSON. No markdown, no code fences, no explanation.`;

/**
 * Classify user intent and get appropriate response.
 * Returns { intent, reply?, reminders?, needsInfo?, command?, args? } or null if AI unavailable.
 */
export async function classifyIntent(userMessage, timezone, currentTime) {
  const api = await ensureClient();
  if (!api) return null;

  if (!aiAvailable) {
    if (Date.now() - lastFailure < COOLDOWN_MS) return null;
    aiAvailable = true;
  }

  try {
    const response = await api.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      temperature: 0.3,
      system: INTENT_PROMPT,
      messages: [{
        role: 'user',
        content: `Current time: ${currentTime}\nTimezone: ${timezone}\nUser message: "${userMessage}"`,
      }],
    });

    let text = response.content[0]?.text;
    if (!text) return null;

    text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    return JSON.parse(text);
  } catch (err) {
    console.error('[AI] Intent classification failed:', err.message);
    aiAvailable = false;
    lastFailure = Date.now();
    return null;
  }
}

// Keep the old parseWithAI for backward compatibility
export async function parseWithAI(userMessage, timezone, currentTime) {
  const result = await classifyIntent(userMessage, timezone, currentTime);
  if (!result || result.intent !== 'reminder') return null;
  if (result.needsInfo) return { needsInfo: result.needsInfo };
  if (result.reminders && result.reminders.length > 0) {
    return result.reminders[0]; // return first reminder for backward compat
  }
  return null;
}
