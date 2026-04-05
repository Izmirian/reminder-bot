/**
 * Claude AI integration — intent classification and smart message handling.
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

function buildPrompt(activeReminders) {
  let remindersContext = '';
  if (activeReminders && activeReminders.length > 0) {
    remindersContext = '\n\nThe user currently has these active reminders:\n';
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    for (let i = 0; i < activeReminders.length; i++) {
      const r = activeReminders[i];
      const letter = letters[i] || String(i);
      const time = new Date(r.remind_at).toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true,
      });
      const recur = r.cron_expr ? ' (recurring)' : '';
      const notes = r.notes ? ` [note: ${r.notes}]` : '';
      remindersContext += `${letter}) ID=${r.id}: "${r.text}" — ${time}${recur}${notes}\n`;
    }
    remindersContext += '\nUsers refer to reminders by letter (a, b, c), by name, by "both", "all", "first", "last", etc. ALWAYS return the numeric ID values in the "ids" array, not the letters. When user says "cancel a and b" or "cancel 1 and 3", return ALL mentioned IDs.';
  } else {
    remindersContext = '\n\nThe user has no active reminders.';
  }

  return `You are a smart assistant inside a reminder bot. Your job is to understand the user's intent and respond appropriately.

Classify the message into one of these intents and return a JSON object:

1. **"reminder"** — The user wants to set one or more reminders.
   Return: { "intent": "reminder", "reminders": [{ "text": "...", "remindAt": "ISO8601", "cronExpr": "cron or null", "category": "health|work|personal|null", "notes": "extra info or null", "priority": "low|normal|urgent" }] }
   - Priority detection: "urgent", "important", "ASAP", "critical", "don't forget!", ALL CAPS emphasis, exclamation marks = "urgent". "low priority", "whenever", "not important" = "low". Default = "normal".
   - If the message contains MULTIPLE reminders, return multiple items in the array.
   - If a message has a main task AND extra context/details, create ONE reminder with the task as "text" and the extra info as "notes".
   - "notes" is for ANY supplementary information: amounts, details, what to bring, context, reasons, etc.
   - Examples of notes detection:
     - "remind me to test cad in 2 mins ill be bringing a car" → text="test cad", notes="bringing a car"
     - "head to factory at 4:30 also note I need 15k" → text="head to factory", notes="need 15k"
     - "call john at 3pm about the project deadline" → text="call john", notes="about the project deadline"
     - "buy groceries at 5pm milk eggs bread" → text="buy groceries", notes="milk, eggs, bread"
   - If additional sentences after the reminder task don't include a new time, they're probably notes, not separate reminders.
   - If you can't determine the time, return: { "intent": "reminder", "needsInfo": "short clarifying question" }

2. **"chat"** — The user is chatting, greeting, asking a question, or making conversation.
   Return: { "intent": "chat", "reply": "Your friendly response here" }
   - Be CONCISE and DIRECT. Lead with the answer, not filler words.
   - Use short lines and line breaks for readability. No long paragraphs.
   - When answering questions about reminders/schedule, use a clear format:
     - "Do I have anything Monday?" → "*No reminders for Monday.*\nYou have: be in the car by 9:35 (daily except Fri)\nWant to set something?"
     - "What time is it?" → "It's 10:18 PM in Amman."
   - For greetings: keep it short. "Hey! Need a reminder?" not a paragraph.
   - NEVER repeat back what the user said. Just answer.
   - Use bold (*text*) for key info. Use line breaks between distinct points.

3. **"command"** — The user wants a general bot action (NOT cancel/edit/reschedule — those are "action").
   Return: { "intent": "command", "command": "list|clear_all|clear_today|pause|resume|undo|repeat|summary|streaks|timezone|digest|location|help|menu", "args": "optional" }
   - "set location Amman" or "my city is Dubai" → command=location, args="Amman" or "Dubai"
   - IMPORTANT: "cancel", "delete", "remove", "edit", "change", "move", "reschedule" referring to existing reminders should ALWAYS use intent "action", NOT "command".

4. **"action"** — The user wants to cancel, edit, reschedule, or add notes to EXISTING reminders. Use this for ANY message about modifying, deleting, removing, or changing reminders.
   Return: { "intent": "action", "action": "cancel|edit|reschedule|add_note", "ids": [1, 2], "newTime": "ISO8601 or null", "newText": "new text or null", "note": "note text or null" }
   - "cancel both" or "cancel all" → ids = all active reminder IDs
   - "cancel the soccer one" → match by text, return its ID
   - "move dinner to 8pm" → action=reschedule, match "dinner" to its ID, include newTime
   - "change soccer to basketball" → action=edit, match "soccer" to its ID, include newText
   - "delete the first one" → ids = [first reminder ID]
   - "note: bring the documents" or "add note to factory reminder: need 15k" → action=add_note, match reminder, include note
   - If you can't determine which reminder, return: { "intent": "action", "needsInfo": "Which reminder? ..." }

5. **"search"** — The user wants to find past or current reminders.
   Return: { "intent": "search", "query": "search text or null", "dateRange": { "from": "ISO8601", "to": "ISO8601" } or null }
   - "what did I have last Tuesday" → search with dateRange for last Tuesday full day
   - "search groceries" → query="groceries", no dateRange
   - "show my completed reminders" → query=null, no dateRange (show all)
   - "find reminders from last week" → dateRange for last 7 days
   - "did I have anything about dentist?" → query="dentist"

Time context:
- "after lunch" = 1:00 PM, "after work" = 6:00 PM, "morning" = 9:00 AM
- "this afternoon" = 2:00 PM, "evening" = 7:00 PM, "tonight" = 9:00 PM
- "end of day" = 5:00 PM, "later" = 2 hours from now
- "noon" = 12:00 PM, "midnight" = 12:00 AM next day
- "dawn" = 6:00 AM, "dusk" = 6:00 PM
- "this weekend" = Saturday 10:00 AM, "next weekend" = next Saturday 10:00 AM
- "next Monday morning" = next Monday 9:00 AM (combine day + time-of-day)
- "tomorrow morning" = tomorrow 9:00 AM, "tomorrow evening" = tomorrow 7:00 PM
- "tonight" = today 9:00 PM, "this evening" = today 7:00 PM

Category: health (medicine, doctor, gym), work (meeting, email, deadline), personal (groceries, buy, clean)
${remindersContext}

Return ONLY valid JSON. No markdown, no code fences, no explanation.`;
}

/**
 * Classify user intent with context about their active reminders.
 */
export async function classifyIntent(userMessage, timezone, currentTime, activeReminders) {
  const api = await ensureClient();
  if (!api) return null;

  if (!aiAvailable) {
    if (Date.now() - lastFailure < COOLDOWN_MS) return null;
    aiAvailable = true;
  }

  // Convert to local time string so AI gets the correct time
  let localTimeStr;
  try {
    localTimeStr = new Date().toLocaleString('en-US', {
      timeZone: timezone,
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
    });
  } catch {
    localTimeStr = currentTime;
  }

  try {
    const response = await api.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      temperature: 0.3,
      system: buildPrompt(activeReminders),
      messages: [{
        role: 'user',
        content: `Current local time: ${localTimeStr}\nTimezone: ${timezone}\nUser message: "${userMessage}"`,
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

// Backward compat
export async function parseWithAI(userMessage, timezone, currentTime) {
  const result = await classifyIntent(userMessage, timezone, currentTime, []);
  if (!result || result.intent !== 'reminder') return null;
  if (result.needsInfo) return { needsInfo: result.needsInfo };
  if (result.reminders && result.reminders.length > 0) return result.reminders[0];
  return null;
}
