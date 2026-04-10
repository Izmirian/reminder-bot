/**
 * Shared assistant logic — handles list, contact, journal, memory, expense, timer, summarize intents.
 * Used by both Telegram and WhatsApp handlers to avoid duplication.
 */
import {
  getList, getAllLists, upsertListItems, deleteList,
  upsertContact, getContact, getAllContacts, getUpcomingBirthdays,
  addJournalEntry, getJournalEntries, searchJournal,
  addMemory, getMemories, searchMemory, deleteMemory,
  addExpense, getExpenses, getExpenseSummary,
  getActiveReminders, getAllStreaks, getUserMonitors, getSettings,
} from './db.js';

// Active timers per chat
const activeTimers = new Map(); // chatId -> { timeout, label, endsAt }

/**
 * Handle a "list" intent. Returns a response string.
 */
export async function handleListIntent(chatId, aiResult) {
  const { action, listName, items } = aiResult;

  if (action === 'show' && !listName) {
    const lists = await getAllLists(chatId);
    if (lists.length === 0) return 'No lists yet. Try "add milk to grocery list"';
    let msg = '*Your Lists*\n';
    for (const l of lists) {
      const parsed = typeof l.items === 'string' ? JSON.parse(l.items) : l.items;
      msg += `\n*${l.list_name}* (${parsed.length} items)`;
    }
    return msg;
  }

  if (action === 'show') {
    const list = await getList(chatId, listName);
    if (!list) return `No "${listName}" list yet. Add items with "add X to ${listName} list"`;
    const parsed = typeof list.items === 'string' ? JSON.parse(list.items) : list.items;
    if (parsed.length === 0) return `"${listName}" list is empty.`;
    let msg = `*${list.list_name}*\n`;
    parsed.forEach((item, i) => { msg += `${i + 1}. ${item}\n`; });
    return msg;
  }

  if (action === 'add' && items?.length) {
    const list = await getList(chatId, listName);
    const existing = list ? (typeof list.items === 'string' ? JSON.parse(list.items) : list.items) : [];
    const updated = [...existing, ...items];
    await upsertListItems(chatId, listName, updated);
    return `Added ${items.join(', ')} to *${listName}* list (${updated.length} items)`;
  }

  if (action === 'remove' && items?.length) {
    const list = await getList(chatId, listName);
    if (!list) return `No "${listName}" list found.`;
    const existing = typeof list.items === 'string' ? JSON.parse(list.items) : list.items;
    const lower = items.map(i => i.toLowerCase());
    const updated = existing.filter(item => !lower.includes(item.toLowerCase()));
    await upsertListItems(chatId, listName, updated);
    return `Removed ${items.join(', ')} from *${listName}* list`;
  }

  if (action === 'clear') {
    await deleteList(chatId, listName);
    return `Cleared *${listName}* list`;
  }

  return 'Not sure what to do with that list command.';
}

/**
 * Handle a "contact" intent.
 */
export async function handleContactIntent(chatId, aiResult) {
  const { action, name, notes, birthday } = aiResult;

  if (action === 'save') {
    await upsertContact(chatId, name, notes, birthday);
    let msg = `Saved info about *${name}*`;
    if (birthday) msg += `\nBirthday: ${birthday}`;
    if (notes) msg += `\n${notes}`;
    return msg;
  }

  if (action === 'lookup') {
    const contact = await getContact(chatId, name);
    if (!contact) return `I don't have any info about "${name}".`;
    let msg = `*${contact.name}*`;
    if (contact.birthday) msg += `\nBirthday: ${contact.birthday}`;
    if (contact.notes) msg += `\n${contact.notes}`;
    return msg;
  }

  if (action === 'list') {
    const contacts = await getAllContacts(chatId);
    if (contacts.length === 0) return 'No contacts saved yet. Try "remember John\'s birthday is March 5"';
    let msg = '*Your Contacts*\n';
    for (const c of contacts) {
      msg += `\n*${c.name}*`;
      if (c.birthday) msg += ` (${c.birthday})`;
      if (c.notes) msg += ` — ${c.notes}`;
    }
    return msg;
  }

  return 'Not sure what to do with that contact command.';
}

/**
 * Handle a "journal" intent.
 */
export async function handleJournalIntent(chatId, aiResult, timezone) {
  const { action, entry, mood, query: searchQuery, dateRange } = aiResult;

  if (action === 'write') {
    await addJournalEntry(chatId, entry, mood);
    const moodLabel = mood ? ` (${mood})` : '';
    return `Journal entry saved${moodLabel}`;
  }

  if (action === 'read') {
    const entries = await getJournalEntries(chatId, dateRange?.from, dateRange?.to);
    if (entries.length === 0) return 'No journal entries found for that period.';
    let msg = '*Journal*\n';
    for (const e of entries) {
      const date = new Date(e.created_at).toLocaleDateString('en-US', {
        timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric',
      });
      const moodLabel = e.mood ? ` (${e.mood})` : '';
      msg += `\n*${date}*${moodLabel}\n${e.entry}\n`;
    }
    return msg;
  }

  if (action === 'search') {
    const entries = await searchJournal(chatId, searchQuery);
    if (entries.length === 0) return `No journal entries matching "${searchQuery}".`;
    let msg = `*Journal — "${searchQuery}"*\n`;
    for (const e of entries) {
      const date = new Date(e.created_at).toLocaleDateString('en-US', {
        timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric',
      });
      msg += `\n*${date}*\n${e.entry}\n`;
    }
    return msg;
  }

  return 'Not sure what to do with that journal command.';
}

/**
 * Handle a "memory" intent.
 */
export async function handleMemoryIntent(chatId, aiResult) {
  const { action, fact, query: searchQuery, id } = aiResult;

  if (action === 'save') {
    await addMemory(chatId, fact);
    return `Got it, I'll remember that.`;
  }

  if (action === 'recall') {
    const results = await searchMemory(chatId, searchQuery);
    if (results.length === 0) return `I don't remember anything about "${searchQuery}".`;
    let msg = '';
    for (const m of results) { msg += `• ${m.fact}\n`; }
    return msg.trim();
  }

  if (action === 'list') {
    const all = await getMemories(chatId);
    if (all.length === 0) return 'I don\'t have any saved memories yet. Tell me something to remember!';
    let msg = '*What I know about you*\n';
    for (const m of all) { msg += `\n#${m.id} ${m.fact}`; }
    return msg;
  }

  if (action === 'forget' && id) {
    await deleteMemory(chatId, id);
    return 'Forgotten.';
  }

  return 'Not sure what to do with that.';
}

/**
 * Handle an "expense" intent.
 */
export async function handleExpenseIntent(chatId, aiResult) {
  const { action, amount, description, category, period } = aiResult;

  if (action === 'add' && amount) {
    await addExpense(chatId, Number(amount), description, category);
    const catLabel = category ? ` (${category})` : '';
    return `Logged *${amount}*${catLabel}${description ? ` — ${description}` : ''}`;
  }

  if (action === 'summary') {
    const days = period === 'today' ? 1 : period === 'month' ? 30 : 7;
    const summary = await getExpenseSummary(chatId, days);
    const label = period === 'today' ? 'today' : period === 'month' ? 'this month' : 'this week';
    return `*Spending ${label}*\nTotal: *${summary.total.toFixed(2)}*\nTransactions: ${summary.count}`;
  }

  if (action === 'list') {
    const days = period === 'today' ? 1 : period === 'month' ? 30 : 7;
    const expenses = await getExpenses(chatId, days);
    if (expenses.length === 0) return 'No expenses logged recently.';
    const summary = await getExpenseSummary(chatId, days);
    let msg = '*Recent Expenses*\n';
    for (const e of expenses) {
      const date = new Date(e.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const catLabel = e.category ? ` (${e.category})` : '';
      msg += `\n${date} — *${e.amount}*${catLabel} ${e.description || ''}`;
    }
    msg += `\n\n*Total: ${summary.total.toFixed(2)}*`;
    return msg;
  }

  return 'Not sure what to do with that expense.';
}

/**
 * Handle a "timer" intent. Returns { message, scheduleCallback? }
 */
export function handleTimerIntent(chatId, aiResult, sendFn) {
  const { action, minutes, label } = aiResult;

  if (action === 'start') {
    const mins = minutes || 25;
    const timerLabel = label || 'Timer';

    // Cancel existing timer
    const existing = activeTimers.get(chatId);
    if (existing?.timeout) clearTimeout(existing.timeout);

    const endsAt = new Date(Date.now() + mins * 60 * 1000);
    const timeout = setTimeout(async () => {
      try { await sendFn(`*${timerLabel}* is up! (${mins} min)`); } catch (e) { console.error('[Timer] send failed:', e.message); }
      activeTimers.delete(chatId);
    }, mins * 60 * 1000);

    activeTimers.set(chatId, { timeout, label: timerLabel, endsAt });
    return `*${timerLabel}* started — ${mins} minutes. I'll notify you when it's done.`;
  }

  if (action === 'stop') {
    const existing = activeTimers.get(chatId);
    if (!existing) return 'No active timer.';
    clearTimeout(existing.timeout);
    activeTimers.delete(chatId);
    return `*${existing.label}* stopped.`;
  }

  if (action === 'status') {
    const existing = activeTimers.get(chatId);
    if (!existing) return 'No active timer.';
    const remaining = Math.max(0, Math.ceil((existing.endsAt - Date.now()) / 60000));
    return `*${existing.label}* — ${remaining} min remaining`;
  }

  return 'Not sure what to do with that timer command.';
}

/**
 * Build a full dashboard overview of everything.
 */
export async function buildDashboard(chatId, timezone) {
  let msg = '*Dashboard*\n';

  // Reminders
  try {
    const reminders = await getActiveReminders(chatId);
    const today = new Date().toISOString().split('T')[0];
    const todayRems = reminders.filter(r => r.remind_at?.startsWith(today));
    const urgent = reminders.filter(r => r.priority === 'urgent');
    msg += `\n*Reminders:* ${reminders.length} active`;
    if (todayRems.length > 0) msg += ` (${todayRems.length} today)`;
    if (urgent.length > 0) msg += ` | ${urgent.length} urgent`;
    if (reminders.length > 0) {
      const next = reminders[0];
      const time = new Date(next.remind_at).toLocaleString('en-US', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: true,
        weekday: 'short', month: 'short', day: 'numeric',
      });
      msg += `\nNext: *${next.text}* — ${time}`;
    }
  } catch {}

  // Lists
  try {
    const lists = await getAllLists(chatId);
    if (lists.length > 0) {
      msg += '\n';
      for (const l of lists) {
        const items = typeof l.items === 'string' ? JSON.parse(l.items) : l.items;
        msg += `\n*${l.list_name}:* ${items.length} items`;
        if (items.length > 0 && items.length <= 5) msg += ` — ${items.join(', ')}`;
        else if (items.length > 5) msg += ` — ${items.slice(0, 3).join(', ')}...`;
      }
    }
  } catch {}

  // Expenses
  try {
    const week = await getExpenseSummary(chatId, 7);
    const today = await getExpenseSummary(chatId, 1);
    if (week.count > 0) {
      msg += `\n\n*Spending:* ${week.total.toFixed(2)} this week (${week.count} transactions)`;
      if (today.count > 0) msg += `\nToday: ${today.total.toFixed(2)}`;
    }
  } catch {}

  // Streaks
  try {
    const streaks = await getAllStreaks(chatId);
    if (streaks.length > 0) {
      msg += '\n\n*Streaks:*';
      for (const s of streaks.slice(0, 5)) {
        msg += `\n${s.reminder_text}: ${s.current_streak} days`;
      }
    }
  } catch {}

  // Upcoming birthdays
  try {
    const contacts = await getUpcomingBirthdays(chatId);
    const now = new Date();
    const upcoming = contacts.filter(c => {
      if (!c.birthday) return false;
      const [m, d] = c.birthday.split('-').map(Number);
      const bd = new Date(now.getFullYear(), m - 1, d);
      if (bd < now) bd.setFullYear(now.getFullYear() + 1);
      const diff = Math.ceil((bd - now) / 86400000);
      return diff >= 0 && diff <= 14;
    });
    if (upcoming.length > 0) {
      msg += '\n\n*Birthdays:*';
      for (const c of upcoming) msg += `\n🎂 ${c.name} (${c.birthday})`;
    }
  } catch {}

  // URL Monitors
  try {
    const monitors = await getUserMonitors(chatId);
    if (monitors.length > 0) msg += `\n\n*Monitors:* ${monitors.length} active`;
  } catch {}

  // Memory count
  try {
    const memories = await getMemories(chatId);
    if (memories.length > 0) msg += `\n\n*Memory:* ${memories.length} facts saved`;
  } catch {}

  // Timer
  const timer = activeTimers.get(chatId);
  if (timer) {
    const remaining = Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 60000));
    msg += `\n\n*Timer:* ${timer.label} — ${remaining} min remaining`;
  }

  // Settings summary
  try {
    const settings = await getSettings(chatId);
    msg += '\n\n*Settings:*';
    msg += `\nTimezone: ${settings.timezone}`;
    if (settings.location) msg += ` | Location: ${settings.location}`;
    msg += `\nDigest: ${settings.daily_digest ? `ON at ${settings.digest_time}` : 'OFF'}`;
    msg += `\nCalendar: ${settings.google_tokens ? 'Connected' : 'Not connected'}`;
  } catch {}

  return msg;
}

/**
 * Handle a "summarize" intent — fetch URL and summarize.
 */
export async function handleSummarizeIntent(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReminderBot/1.0)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return `Couldn't fetch that URL (${res.status}).`;
    let text = await res.text();
    // Strip HTML
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();

    // Truncate for AI context
    if (text.length > 3000) text = text.substring(0, 3000) + '...';

    // Use Claude to summarize
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: `Summarize this in 3-5 bullet points, concise:\n\n${text}` }],
    });
    return response.content[0]?.text || 'Could not generate summary.';
  } catch (err) {
    return `Failed to summarize: ${err.message}`;
  }
}
