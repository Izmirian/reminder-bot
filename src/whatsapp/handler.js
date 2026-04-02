/**
 * Handles incoming WhatsApp messages — parses reminders, commands, and button replies.
 */
import { sendTextMessage, sendReminderMessage } from './api.js';
import { parseReminderSmart, parseReminder } from '../parser.js';
import {
  createReminder, getActiveReminders, getReminder, deactivateReminder,
  deactivateAllReminders, deactivateTodaysReminders, pauseAllReminders,
  resumeAllReminders, getPausedReminders, getSettings, setTimezone,
  setDailyDigest, updateReminderText, updateReminderTime,
  getTodaysReminders, getLastDeactivated, reactivateReminder,
  getWeeklyStats, snoozeReminder as dbSnooze,
  incrementSnoozeCount, getSnoozeCount, resetSnoozeCount,
  clearIgnoredSince, logCompletedReminder,
} from '../db.js';
import {
  scheduleReminder, cancelReminder,
  snoozeReminder as schedSnooze,
} from './scheduler.js';
import { detectRecurringPattern } from '../patterns.js';
import { getConversationalResponse } from '../conversation.js';

// Track state
const pendingClearAll = new Set();
const pendingClarification = new Map();
const lastCreated = new Map();

// --- Helpers ---

function relativeTime(date) {
  const diff = date.getTime() - Date.now();
  if (diff < 0) return 'overdue';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'less than a minute';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) {
    const parts = [`${hours} hour${hours === 1 ? '' : 's'}`];
    if (remMins > 0) parts.push(`${remMins} min`);
    return parts.join(' ');
  }
  const days = Math.floor(hours / 24);
  if (days === 1) return 'tomorrow';
  return `${days} days`;
}

function formatTime(isoStr, timezone) {
  return new Date(isoStr).toLocaleString('en-US', {
    timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

// --- Main message handler ---

export async function handleTextMessage(from, text) {
  const lower = text.trim().toLowerCase();

  // Pending clear all confirmation
  if (pendingClearAll.has(from)) {
    pendingClearAll.delete(from);
    if (lower === 'yes') return doClearAll(from);
    return sendTextMessage(from, 'Clear all cancelled.');
  }

  // Pending AI clarification
  if (pendingClarification.has(from)) {
    const ctx = pendingClarification.get(from);
    pendingClarification.delete(from);
    const combined = `${ctx.originalText} (${text.trim()})`;
    const settings = getSettings(from);
    const parsed = await parseReminderSmart(combined, settings.timezone);
    if (parsed && !parsed.needsInfo && parsed.remindAt) {
      return saveAndConfirm(from, parsed, settings);
    }
    return sendTextMessage(from, "I still couldn't understand. Try:\n\"remind me at 3pm to call dentist\"");
  }

  // Greetings / Menu
  if (['hi', 'hey', 'hello', 'menu', 'start', '/start', 'yo', 'sup'].includes(lower)) return sendMenu(from);

  // Menu shortcuts
  if (lower === '1') return sendTextMessage(from, '📝 Just type your reminder naturally!\n\nExamples:\n• "remind me at 3pm to call dentist"\n• "in 30 minutes check the oven"\n• "every day at 9am take vitamins"');
  if (lower === '2' || lower === 'view' || lower === 'reminders' || lower === 'my reminders') return sendList(from);
  if (lower === '3' || lower === 'clear all' || lower === 'reset') return handleClearAll(from);
  if (lower === '4') return handleTimezone(from, 'timezone');
  if (lower === '5') return handleDigest(from, 'digest');
  if (lower === '6' || lower === 'help' || lower === '/help') return sendHelp(from);

  // Commands
  if (lower === 'list' || lower === '/list') return sendList(from);
  if (lower === 'today' || lower === "today's reminders" || lower === 'todays reminders' || lower === 'list today') return sendTodaysList(from);
  if (lower === 'clear today' || lower === 'remove today' || lower === "remove today's reminders" || lower === "clear today's reminders") return handleClearToday(from);
  if (lower.startsWith('cancel ') || lower.startsWith('/cancel')) return handleCancel(from, text.trim());
  if (lower.startsWith('timezone ') || lower.startsWith('/timezone')) return handleTimezone(from, text.trim());
  if (lower.startsWith('digest ') || lower.startsWith('/digest')) return handleDigest(from, text.trim());
  if (lower.startsWith('edit ') || lower.startsWith('/edit')) return handleEdit(from, text.trim());
  if (lower === 'pause') return handlePause(from);
  if (lower === 'resume') return handleResume(from);
  if (lower === 'undo') return handleUndo(from);
  if (lower === 'summary' || lower === 'weekly' || lower === 'stats') return handleWeekly(from);
  if (lower === 'repeat' || lower === 'again' || lower === 'repeat last') return handleRepeat(from);

  // Natural conversation check
  const convoResponse = getConversationalResponse(text.trim());
  if (convoResponse) return sendTextMessage(from, convoResponse);

  // Smart parsing (AI first, then chrono fallback)
  const settings = getSettings(from);
  const parsed = await parseReminderSmart(text.trim(), settings.timezone);

  if (!parsed) {
    return sendTextMessage(from,
      "I couldn't understand that. Try:\n• \"remind me at 3pm to call dentist\"\n• \"in 30 minutes check the oven\"\n\nOr send *menu* to see all options."
    );
  }

  // AI needs more info
  if (parsed.needsInfo) {
    pendingClarification.set(from, { originalText: text.trim() });
    return sendTextMessage(from, `🤔 ${parsed.needsInfo}`);
  }

  return saveAndConfirm(from, parsed, settings);
}

async function handleUndo(from) {
  const last = getLastDeactivated(from);
  if (!last) return sendTextMessage(from, 'Nothing to undo.');
  reactivateReminder(last.id);
  scheduleReminder({ ...last, active: 1 });
  return sendTextMessage(from, `↩️ Restored: "${last.text}"`);
}

async function handleRepeat(from) {
  const last = lastCreated.get(from);
  if (!last) return sendTextMessage(from, 'Nothing to repeat. Set a reminder first!');
  const settings = getSettings(from);
  return saveAndConfirm(from, last, settings);
}

async function handleWeekly(from) {
  const stats = getWeeklyStats(from);
  const active = getActiveReminders(from);
  const total = stats.completed + stats.snoozed + stats.missed;

  let msg = '📊 *Weekly Summary*\n\n';
  msg += `✅ Completed: *${stats.completed}*\n`;
  msg += `⏰ Snoozed: *${stats.snoozed}*\n`;
  msg += `❌ Missed: *${stats.missed}*\n`;
  msg += `📝 Active: *${active.length}*\n\n`;

  if (total > 0) {
    const rate = Math.round((stats.completed / total) * 100);
    if (rate >= 80) msg += `🏆 Great job! ${rate}% completion rate!`;
    else if (rate >= 50) msg += `👍 ${rate}% completion rate. Keep it up!`;
    else msg += `💪 ${rate}% completion rate. You can do better!`;
  } else {
    msg += 'No reminders tracked this week.';
  }
  return sendTextMessage(from, msg);
}

async function saveAndConfirm(from, parsed, settings) {
  lastCreated.set(from, parsed);
  const id = createReminder({
    chatId: from, text: parsed.text, remindAt: parsed.remindAt.toISOString(),
    cronExpr: parsed.cronExpr, timezone: settings.timezone, category: parsed.category,
  });

  scheduleReminder({
    id, chat_id: from, text: parsed.text,
    remind_at: parsed.remindAt.toISOString(), cron_expr: parsed.cronExpr, category: parsed.category,
  });

  const timeStr = formatTime(parsed.remindAt.toISOString(), settings.timezone);
  const relTime = relativeTime(parsed.remindAt);
  const catEmoji = { health: '🏥', work: '💼', personal: '🏠' }[parsed.category] || '';
  const recurLabel = parsed.cronExpr ? '\n🔁 Recurring' : '';

  return sendTextMessage(from,
    `✅ Reminder set! ${catEmoji}\n\n📝 *${parsed.text}*\n⏰ ${timeStr} (in ${relTime})${recurLabel}`
  );
}

/**
 * Process a button reply (snooze / done).
 */
export async function handleButtonReply(from, buttonId) {
  if (buttonId.startsWith('snooze:')) {
    const [, idStr, minsStr] = buttonId.split(':');
    const reminderId = parseInt(idStr, 10);
    const minutes = parseInt(minsStr, 10);

    dbSnooze(reminderId, new Date(Date.now() + minutes * 60 * 1000).toISOString());
    schedSnooze(reminderId, minutes);
    clearIgnoredSince(reminderId);

    incrementSnoozeCount(reminderId);
    const count = getSnoozeCount(reminderId);

    const label = minutes >= 60 ? `${minutes / 60} hour(s)` : `${minutes} minutes`;

    if (count >= 3) {
      return sendTextMessage(from,
        `⏰ Snoozed for ${label}\n\n💡 You've snoozed this *${count} times*. Want to reschedule?\nSend: edit ${reminderId} to tomorrow 9am`
      );
    }
    return sendTextMessage(from, `⏰ Snoozed for ${label}`);
  }

  if (buttonId.startsWith('done:')) {
    const reminderId = parseInt(buttonId.split(':')[1], 10);

    const reminder = getReminder(reminderId);
    if (reminder) {
      logCompletedReminder({ chatId: from, text: reminder.text, remindAt: reminder.remind_at });
    }

    cancelReminder(reminderId);
    deactivateReminder(reminderId);
    resetSnoozeCount(reminderId);
    clearIgnoredSince(reminderId);

    await sendTextMessage(from, '✅ Done!');

    // Check for recurring patterns
    const patterns = detectRecurringPattern(from);
    for (const p of patterns) {
      const timeStr = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
      await sendTextMessage(from,
        `💡 I noticed you complete "*${p.text}*" every *${p.dayName}* around *${timeStr}*.\n\n` +
        `Want to make it recurring?\nSend: every ${p.dayName.toLowerCase()} at ${timeStr} ${p.text}`
      );
    }
  }
}

// --- Feature handlers (unchanged) ---

async function sendMenu(to) {
  const reminders = getActiveReminders(to);
  const count = reminders.length;
  const greeting = count > 0
    ? `You have *${count}* active reminder${count === 1 ? '' : 's'}.`
    : 'You have no active reminders.';

  return sendTextMessage(to,
    `🤖 *Hey! What would you like to do?*\n\n${greeting}\n\n` +
    '1️⃣ Set a reminder\n2️⃣ View my reminders\n3️⃣ Clear all reminders\n' +
    '4️⃣ Set timezone\n5️⃣ Daily digest on/off\n6️⃣ Help\n\n' +
    '_Reply with a number or just type your reminder!_'
  );
}

async function sendHelp(to) {
  return sendTextMessage(to,
    '🤖 *Reminder Bot — Help*\n\n' +
    '*Setting Reminders:*\n• "remind me at 3pm to call dentist"\n• "in 30 minutes check the oven"\n• "every day at 8am take vitamins"\n\n' +
    '*Quick Commands:*\n• *menu* — Main menu\n• *view* / *list* — Show reminders\n• *cancel 3* — Cancel reminder #3\n' +
    '• *edit 3 to 5pm* — Change time\n• *edit 3 buy milk* — Change text\n• *clear all* — Remove all reminders\n' +
    '• *pause* / *resume* — Pause/resume all\n• *timezone Asia/Dubai* — Set timezone\n• *digest on* / *digest off* — Daily summary'
  );
}

async function sendList(to) {
  const reminders = getActiveReminders(to);
  const paused = getPausedReminders(to);
  if (reminders.length === 0 && paused.length === 0) {
    return sendTextMessage(to, 'You have no reminders.\nJust type a reminder to set one!');
  }

  const settings = getSettings(to);
  const todayStr = new Date().toISOString().split('T')[0];
  const today = [], upcoming = [], recurring = [];

  for (const r of reminders) {
    if (r.cron_expr) recurring.push(r);
    else if (r.remind_at.startsWith(todayStr)) today.push(r);
    else upcoming.push(r);
  }

  let msg = '📋 *Your Reminders*\n';
  if (today.length > 0) {
    msg += '\n*📅 Today:*\n';
    for (const r of today) {
      const time = new Date(r.remind_at).toLocaleTimeString('en-US', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', hour12: true });
      const rel = relativeTime(new Date(r.remind_at));
      const catEmoji = { health: '🏥', work: '💼', personal: '🏠' }[r.category] || '';
      msg += `  *#${r.id}* ${catEmoji} ${r.text}\n    ⏰ ${time} (in ${rel})\n`;
    }
  }
  if (upcoming.length > 0) {
    msg += '\n*📆 Upcoming:*\n';
    for (const r of upcoming) {
      const time = formatTime(r.remind_at, settings.timezone);
      const rel = relativeTime(new Date(r.remind_at));
      const catEmoji = { health: '🏥', work: '💼', personal: '🏠' }[r.category] || '';
      msg += `  *#${r.id}* ${catEmoji} ${r.text}\n    ⏰ ${time} (in ${rel})\n`;
    }
  }
  if (recurring.length > 0) {
    msg += '\n*🔁 Recurring:*\n';
    for (const r of recurring) {
      const catEmoji = { health: '🏥', work: '💼', personal: '🏠' }[r.category] || '';
      msg += `  *#${r.id}* ${catEmoji} ${r.text}\n    🔁 ${r.cron_expr}\n`;
    }
  }
  if (paused.length > 0) {
    msg += `\n*⏸️ Paused (${paused.length}):*\n`;
    for (const r of paused) msg += `  *#${r.id}* ${r.text}\n`;
    msg += '\n_Send "resume" to reactivate._';
  }
  msg += '\n\n_Cancel: "cancel <id>" | Edit: "edit <id> ..."_';
  return sendTextMessage(to, msg);
}

async function sendTodaysList(from) {
  const settings = getSettings(from);
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: settings.timezone }); // YYYY-MM-DD
  const todays = getTodaysReminders(from, dateStr);

  if (todays.length === 0) return sendTextMessage(from, 'No reminders for today.');

  let msg = '📅 *Today\'s Reminders:*\n\n';
  for (const r of todays) {
    const time = new Date(r.remind_at).toLocaleTimeString('en-US', {
      timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', hour12: true,
    });
    const catEmoji = { health: '🏥', work: '💼', personal: '🏠' }[r.category] || '';
    msg += `*#${r.id}* ${catEmoji} ${r.text}\n  ⏰ ${time}\n`;
  }
  msg += '\n_Send "clear today" to remove all of today\'s reminders._';
  return sendTextMessage(from, msg);
}

async function handleClearToday(from) {
  const settings = getSettings(from);
  const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: settings.timezone });
  const todays = getTodaysReminders(from, dateStr);

  if (todays.length === 0) return sendTextMessage(from, 'No reminders for today to clear.');

  for (const r of todays) cancelReminder(r.id);
  const count = deactivateTodaysReminders(from, dateStr);
  return sendTextMessage(from, `✅ Cleared ${count} reminder${count === 1 ? '' : 's'} for today.`);
}

async function handleClearAll(from) {
  const reminders = getActiveReminders(from);
  if (reminders.length === 0) return sendTextMessage(from, 'You have no active reminders to clear.');
  pendingClearAll.add(from);
  return sendTextMessage(from, `⚠️ Are you sure you want to clear all *${reminders.length}* reminder${reminders.length === 1 ? '' : 's'}?\n\nReply *YES* to confirm.`);
}

async function doClearAll(from) {
  const reminders = getActiveReminders(from);
  for (const r of reminders) cancelReminder(r.id);
  const count = deactivateAllReminders(from);
  return sendTextMessage(from, `✅ Cleared ${count} reminder${count === 1 ? '' : 's'}.`);
}

async function handleCancel(to, text) {
  const match = text.match(/cancel\s+(\d+)/i);
  if (!match) return sendTextMessage(to, 'Usage: *cancel 3*\nSend *view* to see reminder IDs.');
  const id = parseInt(match[1], 10);
  const reminders = getActiveReminders(to);
  const reminder = reminders.find(r => r.id === id);
  if (!reminder) return sendTextMessage(to, `Reminder #${id} not found.`);
  cancelReminder(id);
  deactivateReminder(id);
  return sendTextMessage(to, `✅ Cancelled: "${reminder.text}"`);
}

async function handleEdit(to, text) {
  const match = text.match(/edit\s+(\d+)\s+(.+)/i);
  if (!match) return sendTextMessage(to, 'Usage:\n• *edit 3 to 5pm* — change time\n• *edit 3 buy groceries* — change text');
  const id = parseInt(match[1], 10);
  const change = match[2].trim();
  const reminders = getActiveReminders(to);
  const reminder = reminders.find(r => r.id === id);
  if (!reminder) return sendTextMessage(to, `Reminder #${id} not found.`);
  const settings = getSettings(to);
  if (change.match(/^to\s+/i)) {
    const timeText = change.replace(/^to\s+/i, '');
    const parsed = parseReminder(`remind me at ${timeText} to placeholder`, settings.timezone);
    if (!parsed) return sendTextMessage(to, `Couldn't understand "${timeText}" as a time.`);
    cancelReminder(id);
    updateReminderTime(id, parsed.remindAt.toISOString());
    scheduleReminder({ ...reminder, remind_at: parsed.remindAt.toISOString() });
    return sendTextMessage(to, `✅ Reminder #${id} updated to *${formatTime(parsed.remindAt.toISOString(), settings.timezone)}*`);
  }
  updateReminderText(id, change);
  return sendTextMessage(to, `✅ Reminder #${id} updated: "${change}"`);
}

async function handlePause(from) {
  const reminders = getActiveReminders(from);
  if (reminders.length === 0) return sendTextMessage(from, 'No active reminders to pause.');
  for (const r of reminders) cancelReminder(r.id);
  const count = pauseAllReminders(from);
  return sendTextMessage(from, `⏸️ Paused ${count} reminder${count === 1 ? '' : 's'}.\nSend *resume* to reactivate.`);
}

async function handleResume(from) {
  const paused = getPausedReminders(from);
  if (paused.length === 0) return sendTextMessage(from, 'No paused reminders to resume.');
  const count = resumeAllReminders(from);
  const active = getActiveReminders(from);
  for (const r of active) scheduleReminder(r);
  return sendTextMessage(from, `▶️ Resumed ${count} reminder${count === 1 ? '' : 's'}.`);
}

async function handleTimezone(to, text) {
  const match = text.match(/timezone\s+(.+)/i);
  if (!match) {
    const settings = getSettings(to);
    return sendTextMessage(to, `Your timezone: *${settings.timezone}*\n\nTo change: *timezone Asia/Dubai*`);
  }
  const tz = match[1].trim();
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); } catch {
    return sendTextMessage(to, `"${tz}" is not valid.\nExamples: America/New_York, Europe/London, Asia/Dubai`);
  }
  setTimezone(to, tz);
  return sendTextMessage(to, `✅ Timezone set to *${tz}*`);
}

async function handleDigest(to, text) {
  const match = text.match(/digest\s+(on|off)(?:\s+(\d{2}:\d{2}))?/i);
  if (!match) {
    const settings = getSettings(to);
    const status = settings.daily_digest ? `ON at ${settings.digest_time}` : 'OFF';
    return sendTextMessage(to, `Daily digest: *${status}*\n\nUsage: *digest on* [HH:MM] | *digest off*`);
  }
  if (match[1].toLowerCase() === 'off') { setDailyDigest(to, false); return sendTextMessage(to, '✅ Daily digest turned off.'); }
  const time = match[2] || '08:00';
  setDailyDigest(to, true, time);
  return sendTextMessage(to, `✅ Daily digest enabled at *${time}*`);
}
