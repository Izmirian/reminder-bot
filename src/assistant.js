/**
 * Shared assistant logic — handles list, contact, journal, memory, expense, timer, summarize intents.
 * Used by both Telegram and WhatsApp handlers to avoid duplication.
 */
import {
  getList, getAllLists, upsertListItems, deleteList,
  upsertContact, getContact, getAllContacts,
  addJournalEntry, getJournalEntries, searchJournal,
  addMemory, getMemories, searchMemory, deleteMemory,
  addExpense, getExpenses, getExpenseSummary,
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
    await addExpense(chatId, amount, description, category);
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
    const timeout = setTimeout(() => {
      sendFn(`*${timerLabel}* is up! (${mins} min)`);
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
