/**
 * Claude AI integration — intent classification and smart message handling.
 * Every message goes through Claude to understand what the user wants.
 */

let client = null;
let aiAvailable = true;
let lastFailure = 0;
const COOLDOWN_MS = 10_000; // 10s cooldown (was 60s — too aggressive)

// Rate limiting — max 30 API calls per minute per chat, 200 total per minute
const rateLimiter = { perChat: new Map(), totalCount: 0, lastReset: Date.now() };
function checkRateLimit(chatId) {
  const now = Date.now();
  if (now - rateLimiter.lastReset > 60_000) {
    rateLimiter.perChat.clear();
    rateLimiter.totalCount = 0;
    rateLimiter.lastReset = now;
  }
  rateLimiter.totalCount++;
  const chatCount = (rateLimiter.perChat.get(chatId) || 0) + 1;
  rateLimiter.perChat.set(chatId, chatCount);
  if (chatCount > 30) { console.warn(`[Rate] Chat ${chatId} exceeded 30 req/min`); return false; }
  if (rateLimiter.totalCount > 200) { console.warn('[Rate] Total exceeded 200 req/min'); return false; }
  return true;
}

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

  return `You are a smart personal assistant. You help with reminders, lists, notes, tracking, and general questions. You can do math, conversions, translations, timezone lookups, and more. Respond in the same language the user writes in.

Classify the message into one of these intents and return a JSON object:

1. **"reminder"** — The user wants to set one or more reminders.
   Return: { "intent": "reminder", "reminders": [{ "text": "...", "remindAt": "ISO8601", "cronExpr": "cron or null", "category": "health|work|personal|null", "notes": "extra info or null", "priority": "low|normal|urgent", "sharedWith": ["phone_or_id"] or null }] }
   - Priority detection: "urgent", "important", "ASAP", "critical", "don't forget!", ALL CAPS emphasis, exclamation marks = "urgent". "low priority", "whenever", "not important" = "low". Default = "normal".
   - Shared reminders: "remind me and 962791234567 about dinner" → sharedWith=["962791234567"]. "remind me and mom" → sharedWith=null (can't resolve names to IDs). Only include phone numbers or exact IDs the user provides.
   - If the message contains MULTIPLE reminders, return multiple items in the array.
   - If a message has a main task AND extra context/details, create ONE reminder with the task as "text" and the extra info as "notes".
   - "notes" is for ANY supplementary information: amounts, details, what to bring, context, reasons, etc.
   - Examples of notes detection:
     - "remind me to test cad in 2 mins ill be bringing a car" → text="test cad", notes="bringing a car"
     - "head to factory at 4:30 also note I need 15k" → text="head to factory", notes="need 15k"
     - "call john at 3pm about the project deadline" → text="call john", notes="about the project deadline"
     - "buy groceries at 5pm milk eggs bread" → text="buy groceries", notes="milk, eggs, bread"
   - If additional sentences after the reminder task don't include a new time, they're probably notes, not separate reminders.
   - **Daily standup:** If the user lists multiple tasks for today ("today I need to finish report, call Sarah, gym at 6"), create a SEPARATE reminder for each task. Tasks with specific times get that time. Tasks without times → ask for time only for those specific tasks, still create the ones that have times.
   - IMPORTANT: If the user provides ONLY a day/date (e.g., "tomorrow", "Monday", "next week", "this weekend") WITHOUT a specific time or time-of-day phrase (morning, afternoon, evening, tonight, noon, etc.), return needsInfo asking what time. Do NOT guess or default to 9am. "Tomorrow" alone is NOT enough — ask "What time tomorrow?"
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
   - Answer naturally like a smart friend. Don't redirect to reminders unless relevant.
   - **Math/conversions**: "15% tip on 80" → "*$12.00*", "convert 100 USD to JOD" → "*~70.90 JOD*", "split 240 between 4" → "*60 each*"
   - **Timezone**: "what time in New York?" → "*It's 4:53 PM in New York* (7 hours behind Amman)"
   - **Translation**: "translate 'where is the hotel' to Arabic" → "*أين الفندق*"
   - **Multi-language**: If the user writes in Arabic, respond in Arabic. Match their language naturally.
   - **Auto-date extraction**: If the user mentions an important date in conversation (wedding, birthday, anniversary, deadline, exam, trip, event) with a specific date, include "autoSave": { "event": "description", "date": "YYYY-MM-DD" } in the response alongside the reply. Example: "wedding is June 15" → reply normally AND include autoSave.

3. **"command"** — The user wants a general bot action (NOT cancel/edit/reschedule — those are "action").
   Return: { "intent": "command", "command": "list|clear_all|clear_today|pause|resume|undo|repeat|summary|streaks|dashboard|timezone|digest|location|connect_calendar|disconnect_calendar|help|menu", "args": "optional" }
   - "dashboard", "overview", "show me everything", "status", "my day" → command=dashboard
   - "set location Amman" or "my city is Dubai" → command=location, args="Amman" or "Dubai"
   - "connect google calendar" or "sync my calendar" → command=connect_calendar
   - "disconnect calendar" → command=disconnect_calendar
   - IMPORTANT: "cancel", "delete", "remove", "edit", "change", "move", "reschedule" referring to existing reminders should ALWAYS use intent "action", NOT "command".

4. **"action"** — The user wants to cancel, edit, reschedule, or add notes to EXISTING reminders. Use this for ANY message about modifying, deleting, removing, or changing reminders.
   Keywords that ALWAYS mean action intent: "switch", "change", "move", "shift", "reschedule", "push", "delay", "postpone", "bring forward", "cancel", "delete", "remove" — when referring to reminders.
   Return for single reschedule: { "intent": "action", "action": "reschedule", "ids": [1, 2], "newTime": "ISO8601" }
   Return for MULTIPLE reminders with DIFFERENT times: { "intent": "action", "action": "reschedule", "updates": [{"id": 1, "newTime": "ISO8601"}, {"id": 2, "newTime": "ISO8601"}] }
   Return for edit/cancel/note: { "intent": "action", "action": "cancel|edit|add_note|complete", "ids": [1, 2], "newText": "new text or null", "note": "note text or null" }
   - "cancel both" or "cancel all" → ids = all active reminder IDs
   - "cancel the soccer one" → match by text, return its ID
   - "move dinner to 8pm" → action=reschedule, match "dinner" to its ID, include newTime
   - "switch gold exchange to 10:30am and lady bug to 10:45am" → action=reschedule, updates=[{id: <gold>, newTime: "...10:30"}, {id: <lady bug>, newTime: "...10:45"}]
   - "push X and Y to 9am" → action=reschedule, ids=[X, Y], newTime="...09:00" (same time for both)
   - "change soccer to basketball" → action=edit, match "soccer" to its ID, include newText
   - "delete the first one" → ids = [first reminder ID]
   - "done with dentist" or "finished the gym" or "completed the call" → action=complete, match by text, return its ID. This MARKS IT DONE (logs completion + deactivates), different from cancel.
   - "mark all as done", "mark all reminders as done", "complete everything", "finish all tasks" → action=complete, ids = ALL active reminder IDs
   - "note: bring the documents" or "add note to factory reminder: need 15k" → action=add_note, match reminder, include note
   - If you can't determine which reminder, return: { "intent": "action", "needsInfo": "Which reminder? ..." }

5. **"monitor"** — The user wants to watch a URL for changes or price drops.
   Return: { "intent": "monitor", "action": "create|list|stop", "url": "full URL or null", "label": "short name or null", "type": "change|price", "id": number or null }
   - "watch amazon.com/dp/B123 for price drops" → action=create, url="https://amazon.com/dp/B123", type="price"
   - "monitor example.com for changes" → action=create, url="https://example.com", type="change"
   - "list my monitors" or "what am I watching?" → action=list
   - "stop monitoring 1" or "stop watching amazon" → action=stop
   - Always include https:// if not in the URL

6. **"search"** — The user wants to find past or current reminders.
   Return: { "intent": "search", "query": "search text or null", "dateRange": { "from": "ISO8601", "to": "ISO8601" } or null }
   - "what did I have last Tuesday" → search with dateRange for last Tuesday full day
   - "search groceries" → query="groceries", no dateRange
   - "show my completed reminders" → query=null, no dateRange (show all)
   - "find reminders from last week" → dateRange for last 7 days
   - "did I have anything about dentist?" → query="dentist"

7. **"list"** — The user wants to manage a list (grocery, shopping, todo, etc.).
   Return: { "intent": "list", "action": "add|remove|show|clear", "listName": "grocery|shopping|todo|...", "items": ["item1", "item2"] or null }
   - "add milk to grocery list" → action=add, listName="grocery", items=["milk"]
   - "add eggs and bread to shopping" → action=add, listName="shopping", items=["eggs", "bread"]
   - "show my grocery list" → action=show, listName="grocery"
   - "remove milk from grocery" → action=remove, listName="grocery", items=["milk"]
   - "clear grocery list" → action=clear, listName="grocery"
   - "what lists do I have?" → action=show, listName=null (show all)

8. **"contact"** — The user wants to save info about a person.
   Return: { "intent": "contact", "action": "save|lookup|list", "name": "John", "notes": "info or null", "birthday": "MM-DD or null" }
   - "remember John's birthday is March 5" → action=save, name="John", birthday="03-05"
   - "John is allergic to nuts" → action=save, name="John", notes="allergic to nuts"
   - "what do you know about John?" → action=lookup, name="John"
   - "show my contacts" → action=list

9. **"journal"** — The user wants to write or read journal entries.
   Return: { "intent": "journal", "action": "write|read|search", "entry": "text or null", "mood": "happy|sad|stressed|productive|calm|null", "query": "search text or null", "dateRange": { "from": "ISO8601", "to": "ISO8601" } or null }
   - "journal: had a great meeting today" → action=write, entry="had a great meeting today", mood="productive"
   - "what did I journal last Monday?" → action=read, dateRange for last Monday
   - "search journal for meeting" → action=search, query="meeting"

10. **"memory"** — The user wants the bot to remember or recall a fact.
   Return: { "intent": "memory", "action": "save|recall|list|forget", "fact": "text", "query": "search text or null", "id": number or null }
   - "remember that my car is a BMW X5" → action=save, fact="car is a BMW X5"
   - "remember I'm allergic to shellfish" → action=save, fact="allergic to shellfish"
   - IMPORTANT: "remember TO [do something]" with a time = REMINDER intent, not memory. "remember to call John at 3pm" → reminder. "remember my car is BMW" (no time, stating a fact) → memory.
   - "what car do I have?" → action=recall, query="car"
   - "what do you know about me?" → action=list
   - "forget that" or "forget #3" → action=forget, id=3

11. **"expense"** — The user is logging spending or asking about expenses.
   Return: { "intent": "expense", "action": "add|summary|list|recurring", "amount": number or null, "description": "text or null", "category": "food|transport|shopping|bills|entertainment|other|null", "currency": "JOD|USD|EUR|GBP|null", "period": "today|week|month|null", "recurring": false, "cronDay": number or null }
   - "spent 50 on lunch" → action=add, amount=50, description="lunch", category="food", currency=null (defaults to JOD)
   - "spent 30 USD on Amazon" → action=add, amount=30, description="Amazon", category="shopping", currency="USD"
   - "paid 200 for electricity" → action=add, amount=200, description="electricity", category="bills"
   - "rent is 500 every 1st" → action=recurring, amount=500, description="rent", category="bills", cronDay=1
   - "internet is 25 every 15th" → action=recurring, amount=25, description="internet", category="bills", cronDay=15
   - "how much did I spend this week?" → action=summary, period="week"
   - "show my expenses" → action=list, period="week"
   - Default currency is JOD if not specified. Only set currency if user explicitly mentions USD, EUR, etc.
   - **Auto-detect spending:** If the user sends just a number + store/description like "50 carrefour" or "120 pharmacy" or "25 uber", classify as expense with action=add. No need for "spent" keyword.

12. **"timer"** — The user wants a pomodoro/focus timer.
   Return: { "intent": "timer", "action": "start|stop|status", "minutes": number or null, "label": "text or null" }
   - "start a 25 min focus session" → action=start, minutes=25, label="focus session"
   - "pomodoro" → action=start, minutes=25, label="pomodoro"
   - "set a 10 min timer" → action=start, minutes=10
   - "stop timer" → action=stop

13. **"summarize"** — The user wants a URL/link summarized.
   Return: { "intent": "summarize", "url": "full URL" }
   - "summarize this: https://example.com/article" → url="https://example.com/article"
   - "what's this about? https://..." → url extracted from message

14. **"project"** — The user wants to manage project groupings for tasks.
   Return: { "intent": "project", "action": "create|list|show|add_task|archive", "name": "project name", "taskText": "task description or null" }
   - "create project Wedding" → action=create, name="Wedding"
   - "add to project Wedding: book venue" → action=add_task, name="Wedding", taskText="book venue"
   - "show project Wedding" → action=show, name="Wedding"
   - "my projects" → action=list
   - "archive project Wedding" → action=archive, name="Wedding"

15. **"pin"** — The user wants to pin/save important info or jot down a quick note.
   Return: { "intent": "pin", "action": "save|list|remove", "content": "text to pin or null", "id": number or null }
   - "pin this: meeting moved to Thursday" → action=save, content="meeting moved to Thursday"
   - "pin: John's new number is 079..." → action=save, content="John's new number is 079..."
   - "note: meeting moved to 3pm" → action=save, content="meeting moved to 3pm"
   - "jot down: call supplier about order" → action=save, content="call supplier about order"
   - "quick note: parking spot B42" → action=save, content="parking spot B42"
   - "show my pins" or "pinned" or "show my notes" → action=list
   - "unpin 3" → action=remove, id=3

16. **"followup"** — The user wants to track something they're waiting on from someone.
   Return: { "intent": "followup", "action": "create|list|done|done_all", "person": "name", "subject": "what", "days": number or null, "id": number or null }
   - "follow up with Sarah in 3 days about the proposal" → action=create, person="Sarah", subject="proposal", days=3
   - "waiting on John for the invoice" → action=create, person="John", subject="invoice", days=3
   - "reply to Mrs Samia" → action=create, person="Mrs Samia", subject="reply", days=3
   - "get back to John" → action=create, person="John", subject="get back", days=3
   - "respond to Sarah" → action=create, person="Sarah", subject="respond", days=3
   - IMPORTANT: "reply to [person]", "get back to [person]", "respond to [person]" = followup tracking, NOT email. Only use "email" intent when user explicitly says "draft email", "email", or "send email".
   - "show follow-ups" → action=list
   - "followup 2 done" → action=done, id=2
   - "mark all follow-ups as done", "complete all followups", "remove follow ups", "clear followups", "mark followups as completed" → action=done_all (marks every pending follow-up as done)

17. **"research"** — The user wants multi-source research or price comparison.
   Return: { "intent": "research", "query": "what to research", "type": "general|price" }
   - "research best restaurants in Amman" → query="best restaurants in Amman", type="general"
   - "compare prices for iPhone 16 in Jordan" → query="iPhone 16 Jordan price", type="price"

18. **"email"** — The user wants to draft an email.
   Return: { "intent": "email", "to": "recipient name or email", "subject": "subject line", "body": "email body or key points" }
   - "draft an email to John about the meeting" → to="John", subject="Meeting", body="key points about the meeting"
   - "email sarah@company.com: project update is ready" → to="sarah@company.com", subject="Project Update", body="The project update is ready"

19. **"github"** — The user asks about their code project, repo, PRs, builds, deploys, or code files.
   Return: { "intent": "github", "query": "the full user question" }
   - "any open PRs?" → query="any open PRs"
   - "show me recent commits" → query="recent commits"
   - "what's the build status?" → query="build status"
   - "read src/index.js" → query="read src/index.js"
   - "search for handleAuth in the codebase" → query="search handleAuth"
   - "what's in the project?" → query="project overview"
   - "did the deploy succeed?" → query="deploy status"
   - "list the src folder" → query="list src"

Time-of-day phrases (these provide a specific time):
- "morning" = 9:00 AM, "afternoon" = 2:00 PM, "evening" = 7:00 PM, "tonight" = 9:00 PM
- "after lunch" = 1:00 PM, "after work" = 6:00 PM, "end of day" = 5:00 PM
- "noon" = 12:00 PM, "midnight" = 12:00 AM next day
- "dawn" = 6:00 AM, "dusk" = 6:00 PM
- "later" = 2 hours from now

Day + time-of-day combos (these are valid because they include BOTH day and time):
- "tomorrow morning" = tomorrow 9:00 AM, "tomorrow evening" = tomorrow 7:00 PM
- "next Monday morning" = next Monday 9:00 AM
- "this weekend morning" = Saturday 10:00 AM

Smart time phrases:
- "after this meeting" or "after my meeting" → return remindAt as "AFTER_MEETING" (handler will check calendar for next event end time)
- "after work" = 6:00 PM (already defined above)

Bare hour without AM/PM (e.g. "at 9", "at 7 to call mom"): resolve to the NEXT upcoming occurrence of that hour relative to the current local time. If it's currently 2:00 PM, "at 9" means 9:00 PM today; if it's currently 10:00 PM, "at 9" means 9:00 AM tomorrow. Always state the resolved time so the user can correct it. Do NOT silently default a bare hour to AM.

INVALID (day/date ONLY — no time specified, must ask for time):
- "tomorrow" alone → needsInfo: "What time tomorrow?"
- "Monday" alone → needsInfo: "What time on Monday?"
- "next week" alone → needsInfo: "What day and time next week?"
- "this weekend" alone → needsInfo: "What time this weekend?"

Category: health (medicine, doctor, gym), work (meeting, email, deadline), personal (groceries, buy, clean)
${remindersContext}

Return ONLY valid JSON. No markdown, no code fences, no explanation.`;
}

/**
 * Classify user intent with context about their active reminders.
 */
import { addChatMessage, getChatHistory as dbGetChatHistory } from './db.js';

export async function addToHistory(chatId, role, content) {
  try { await addChatMessage(chatId, role, content); } catch (e) { console.error('[History]', e.message); }
}

export async function classifyIntent(userMessage, timezone, currentTime, activeReminders, chatId) {
  // Rate limit check
  if (chatId && !checkRateLimit(chatId)) return null;

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
    // Smart history: skip for simple commands, reduce for most messages
    // Cap message length to prevent excessive token usage
    if (userMessage.length > 5000) userMessage = userMessage.substring(0, 5000);
    const lowerMsg = userMessage.toLowerCase().trim();
    const isSimpleCommand = /^(list|menu|help|dashboard|overview|status|streaks|undo|digest|pause|resume|show my|pinned|my projects)/.test(lowerMsg);
    const needsFullContext = /\b(what did (i|we|you)|follow.?up|earlier|before|last time|you said|you mentioned|we talked|we discussed|referring to|add it|set it|do it|make it|that one|the one|about that|from that)\b/i.test(lowerMsg);

    const historyLimit = isSimpleCommand ? 0 : needsFullContext ? 20 : 10;
    const history = (chatId && historyLimit > 0) ? await dbGetChatHistory(chatId, historyLimit) : [];

    const messages = [
      ...history,
      {
        role: 'user',
        content: `Current local time: ${localTimeStr}\nTimezone: ${timezone}\nUser message: "${userMessage}"`,
      },
    ];

    // Use Haiku for simple intents (cheaper), Sonnet for complex ones
    const needsSonnet = needsFullContext || /summariz|research|compar|analyz|translate|explain|draft.*email|switch.*(?:and|\+)|\b(?:move|change|reschedule|shift|push).*(?:and|\+)/i.test(lowerMsg);
    const model = needsSonnet ? 'claude-sonnet-4-20250514' : 'claude-haiku-4-5-20251001';
    const maxTokens = needsSonnet ? 800 : 400;

    const response = await api.messages.create({
      model,
      max_tokens: maxTokens,
      temperature: 0.3,
      system: buildPrompt(activeReminders),
      messages,
    });

    let text = response.content[0]?.text;
    if (!text) return null;

    text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    let result;
    try {
      result = JSON.parse(text);
    } catch (parseErr) {
      // If Haiku returned bad JSON, retry with Sonnet once
      if (model !== 'claude-sonnet-4-20250514') {
        console.warn(`[AI] Haiku JSON parse failed, retrying with Sonnet`);
        const retryRes = await api.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 800, temperature: 0.3, system: buildPrompt(activeReminders), messages });
        let retryText = retryRes.content[0]?.text;
        if (retryText) {
          retryText = retryText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
          result = JSON.parse(retryText);
        } else { return null; }
      } else {
        throw parseErr;
      }
    }

    // Store in history for context (persisted to DB)
    if (chatId) {
      await addToHistory(chatId, 'user', userMessage);
      // Store rich context so follow-up questions work well
      let summary;
      if (result.intent === 'chat') summary = result.reply;
      else if (result.intent === 'reminder') summary = `Set reminder: ${result.reminders?.map(r => r.text).join(', ')}`;
      else if (result.intent === 'list') summary = `List action: ${result.action} on ${result.listName} — ${result.items?.join(', ') || ''}`;
      else if (result.intent === 'expense') summary = result.amount ? `Logged expense: ${result.amount} — ${result.description}` : `Expense ${result.action}`;
      else if (result.intent === 'memory') summary = result.fact ? `Remembered: ${result.fact}` : `Memory ${result.action}: ${result.query || ''}`;
      else if (result.intent === 'contact') summary = `Contact: ${result.action} ${result.name || ''} ${result.notes || ''} ${result.birthday || ''}`;
      else if (result.intent === 'summarize') summary = `Summarizing URL: ${result.url}`;
      else summary = JSON.stringify(result).substring(0, 500);
      await addToHistory(chatId, 'assistant', summary);
    }

    return result;
  } catch (err) {
    console.error(`[AI] Classification failed (model=${model}):`, err.message);
    // Only cooldown on real API errors, not JSON parse failures (already retried with Sonnet)
    if (!(err instanceof SyntaxError)) {
      aiAvailable = false;
      lastFailure = Date.now();
    }
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
