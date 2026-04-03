import {
  getActiveReminders,
  deactivateReminder,
  deactivateAllReminders,
  deactivateTodaysReminders,
  getTodaysReminders,
  pauseAllReminders,
  resumeAllReminders,
  getPausedReminders,
  getSettings,
  setTimezone,
  setDailyDigest,
  updateReminderText,
  updateReminderTime,
  getLastDeactivated,
  reactivateReminder,
  getWeeklyStats,
} from './db.js';
import { cancelReminder } from './scheduler.js';
import { parseReminder } from './parser.js';

// Track users waiting for "YES" to clear all
const pendingClearAll = new Set();

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
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

const MD = { parse_mode: 'Markdown' };

// --- Exported for use in index.js ---

export { pendingClearAll, relativeTime, formatTime };

// --- Command handlers ---

export function handleMenu(bot, msg) {
  const chatId = msg.chat.id;
  const reminders = getActiveReminders(String(chatId));
  const count = reminders.length;
  const greeting = count > 0
    ? `You have *${count}* active reminder${count === 1 ? '' : 's'}.`
    : 'You have no active reminders.';

  bot.sendMessage(chatId,
    `🤖 *Hey! What would you like to do?*\n\n${greeting}\n\n` +
    '/set — Set a reminder\n' +
    '/list — View my reminders\n' +
    '/clearall — Clear all reminders\n' +
    '/pause — Pause all reminders\n' +
    '/resume — Resume paused reminders\n' +
    '/timezone — Set timezone\n' +
    '/digest — Daily digest on/off\n' +
    '/help — Full help',
    MD
  );
}

export function handleHelp(bot, msg) {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    '🤖 *Reminder Bot — Help*\n\n' +
    '*Setting Reminders:*\n' +
    'Just send a natural message:\n' +
    '• "remind me at 3pm to call dentist"\n' +
    '• "remind me in 30 minutes to check oven"\n' +
    '• "every day at 8am take vitamins"\n' +
    '• "every monday at 9am submit timesheet"\n\n' +
    '*Commands:*\n' +
    '/menu — Main menu\n' +
    '/list — Show reminders (grouped)\n' +
    '/cancel `<id>` — Cancel a reminder\n' +
    '/edit `<id>` `<change>` — Edit reminder\n' +
    '/clearall — Clear all reminders\n' +
    '/pause — Pause all reminders\n' +
    '/resume — Resume paused reminders\n' +
    '/timezone `<tz>` — Set timezone\n' +
    '/digest on|off — Daily summary\n\n' +
    '*Snooze:*\n' +
    'Tap the buttons when a reminder fires.',
    MD
  );
}

export function handleSet(bot, msg) {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    '📝 Just type your reminder naturally!\n\n' +
    'Examples:\n' +
    '• "remind me at 3pm to call dentist"\n' +
    '• "in 30 minutes check the oven"\n' +
    '• "every day at 9am take vitamins"'
  );
}

export function handleList(bot, msg) {
  const chatId = msg.chat.id;
  const reminders = getActiveReminders(String(chatId));
  const paused = getPausedReminders(String(chatId));

  if (reminders.length === 0 && paused.length === 0) {
    bot.sendMessage(chatId, 'You have no reminders.\n\nJust type a reminder to set one!\nExample: "remind me at 3pm to call dentist"');
    return;
  }

  const settings = getSettings(String(chatId));
  const todayStr = new Date().toISOString().split('T')[0];

  const today = [];
  const upcoming = [];
  const recurring = [];

  for (const r of reminders) {
    if (r.cron_expr) recurring.push(r);
    else if (r.remind_at.startsWith(todayStr)) today.push(r);
    else upcoming.push(r);
  }

  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let idx = 0;
  let message = '📋 *Your Reminders*\n';

  if (today.length > 0) {
    message += '\n*Today:*\n';
    for (const r of today) {
      const time = new Date(r.remind_at).toLocaleTimeString('en-US', {
        timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', hour12: true,
      });
      const rel = relativeTime(new Date(r.remind_at));
      const noteLabel = r.notes ? `\n    📝 ${r.notes}` : '';
      message += `  *${letters[idx++]})* ${r.text}\n    ${time} (${rel})${noteLabel}\n`;
    }
  }

  if (upcoming.length > 0) {
    message += '\n*Upcoming:*\n';
    for (const r of upcoming) {
      const time = formatTime(r.remind_at, settings.timezone);
      const rel = relativeTime(new Date(r.remind_at));
      const noteLabel = r.notes ? `\n    📝 ${r.notes}` : '';
      message += `  *${letters[idx++]})* ${r.text}\n    ${time} (${rel})${noteLabel}\n`;
    }
  }

  if (recurring.length > 0) {
    message += '\n*Recurring:*\n';
    for (const r of recurring) {
      message += `  *${letters[idx++]})* ${r.text}\n    🔁 ${r.cron_expr}\n`;
    }
  }

  if (paused.length > 0) {
    message += `\n*⏸️ Paused (${paused.length}):*\n`;
    for (const r of paused) {
      message += `  *#${r.id}* ${r.text}\n`;
    }
    message += '\nUse /resume to reactivate.';
  }

  message += '\n\n_Say "cancel a" or "cancel all" to remove._';
  bot.sendMessage(chatId, message, MD);
}

export function handleCancel(bot, msg, match) {
  const chatId = msg.chat.id;
  const idStr = match?.[1]?.trim();

  if (!idStr) {
    bot.sendMessage(chatId, 'Usage: /cancel <id>\nUse /list to see reminder IDs.');
    return;
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    bot.sendMessage(chatId, 'Please provide a valid reminder ID.');
    return;
  }

  const reminders = getActiveReminders(String(chatId));
  const reminder = reminders.find(r => r.id === id);

  if (!reminder) {
    bot.sendMessage(chatId, `Reminder #${id} not found or already completed.`);
    return;
  }

  cancelReminder(id);
  deactivateReminder(id);
  bot.sendMessage(chatId, `✅ Cancelled: "${reminder.text}"`);
}

export function handleEdit(bot, msg, match) {
  const chatId = msg.chat.id;
  const args = match?.[1]?.trim();

  if (!args) {
    bot.sendMessage(chatId, 'Usage:\n/edit 3 to 5pm — change time\n/edit 3 buy groceries — change text');
    return;
  }

  const parts = args.match(/^(\d+)\s+(.+)/);
  if (!parts) {
    bot.sendMessage(chatId, 'Usage: /edit <id> <change>');
    return;
  }

  const id = parseInt(parts[1], 10);
  const change = parts[2].trim();
  const reminders = getActiveReminders(String(chatId));
  const reminder = reminders.find(r => r.id === id);

  if (!reminder) {
    bot.sendMessage(chatId, `Reminder #${id} not found.`);
    return;
  }

  const settings = getSettings(String(chatId));

  // Time change: "to 5pm", "to tomorrow 9am"
  if (change.match(/^to\s+/i)) {
    const timeText = change.replace(/^to\s+/i, '');
    const parsed = parseReminder(`remind me at ${timeText} to placeholder`, settings.timezone);
    if (!parsed) {
      bot.sendMessage(chatId, `Couldn't understand "${timeText}" as a time.`);
      return;
    }

    cancelReminder(id);
    updateReminderTime(id, parsed.remindAt.toISOString());

    // Re-import scheduleReminder dynamically to avoid circular deps
    import('./scheduler.js').then(sched => {
      sched.scheduleReminder({ ...reminder, remind_at: parsed.remindAt.toISOString() });
    });

    const timeStr = formatTime(parsed.remindAt.toISOString(), settings.timezone);
    bot.sendMessage(chatId, `✅ Reminder #${id} updated to *${timeStr}*`, MD);
    return;
  }

  // Text change
  updateReminderText(id, change);
  bot.sendMessage(chatId, `✅ Reminder #${id} updated: "${change}"`);
}

export function handleToday(bot, msg) {
  const chatId = msg.chat.id;
  const settings = getSettings(String(chatId));
  const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: settings.timezone });
  const todays = getTodaysReminders(String(chatId), dateStr);

  if (todays.length === 0) {
    bot.sendMessage(chatId, 'No reminders for today.');
    return;
  }

  let message = '📅 *Today\'s Reminders:*\n\n';
  for (const r of todays) {
    const time = new Date(r.remind_at).toLocaleTimeString('en-US', {
      timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', hour12: true,
    });
    const catEmoji = { health: '🏥', work: '💼', personal: '🏠' }[r.category] || '';
    message += `*#${r.id}* ${catEmoji} ${r.text}\n  ⏰ ${time}\n`;
  }
  message += '\n_Send "clear today" to remove all._';
  bot.sendMessage(chatId, message, MD);
}

export function handleClearToday(bot, msg) {
  const chatId = msg.chat.id;
  const settings = getSettings(String(chatId));
  const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: settings.timezone });
  const todays = getTodaysReminders(String(chatId), dateStr);

  if (todays.length === 0) {
    bot.sendMessage(chatId, 'No reminders for today to clear.');
    return;
  }

  for (const r of todays) cancelReminder(r.id);
  const count = deactivateTodaysReminders(String(chatId), dateStr);
  bot.sendMessage(chatId, `✅ Cleared ${count} reminder${count === 1 ? '' : 's'} for today.`);
}

export function handleClearAll(bot, msg) {
  const chatId = msg.chat.id;
  const reminders = getActiveReminders(String(chatId));

  if (reminders.length === 0) {
    bot.sendMessage(chatId, 'You have no active reminders to clear.');
    return;
  }

  pendingClearAll.add(String(chatId));
  bot.sendMessage(chatId,
    `⚠️ Are you sure you want to clear all *${reminders.length}* reminder${reminders.length === 1 ? '' : 's'}?\n\nSend *YES* to confirm, or anything else to cancel.`,
    MD
  );
}

export function handleClearAllConfirm(bot, msg) {
  const chatId = msg.chat.id;
  const reminders = getActiveReminders(String(chatId));
  for (const r of reminders) cancelReminder(r.id);
  const count = deactivateAllReminders(String(chatId));
  bot.sendMessage(chatId, `✅ Cleared ${count} reminder${count === 1 ? '' : 's'}.`);
}

export function handlePause(bot, msg) {
  const chatId = msg.chat.id;
  const reminders = getActiveReminders(String(chatId));

  if (reminders.length === 0) {
    bot.sendMessage(chatId, 'No active reminders to pause.');
    return;
  }

  for (const r of reminders) cancelReminder(r.id);
  const count = pauseAllReminders(String(chatId));
  bot.sendMessage(chatId, `⏸️ Paused ${count} reminder${count === 1 ? '' : 's'}.\n\nUse /resume to reactivate.`);
}

export function handleResume(bot, msg) {
  const chatId = msg.chat.id;
  const paused = getPausedReminders(String(chatId));

  if (paused.length === 0) {
    bot.sendMessage(chatId, 'No paused reminders to resume.');
    return;
  }

  const count = resumeAllReminders(String(chatId));

  // Re-schedule all resumed reminders
  import('./scheduler.js').then(sched => {
    const active = getActiveReminders(String(chatId));
    for (const r of active) sched.scheduleReminder(r);
  });

  bot.sendMessage(chatId, `▶️ Resumed ${count} reminder${count === 1 ? '' : 's'}.`);
}

export function handleTimezone(bot, msg, match) {
  const chatId = msg.chat.id;
  const tz = match?.[1]?.trim();

  if (!tz) {
    const settings = getSettings(String(chatId));
    bot.sendMessage(chatId, `Your timezone: *${settings.timezone}*\n\nTo change: /timezone Asia/Dubai`, MD);
    return;
  }

  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    bot.sendMessage(chatId, `"${tz}" is not valid. Examples: America/New_York, Europe/London, Asia/Dubai`);
    return;
  }

  setTimezone(String(chatId), tz);
  bot.sendMessage(chatId, `✅ Timezone set to *${tz}*`, MD);
}

export function handleDigest(bot, msg, match) {
  const chatId = msg.chat.id;
  const args = match?.[1]?.trim()?.split(/\s+/) || [];

  if (args.length === 0 || !args[0]) {
    const settings = getSettings(String(chatId));
    const status = settings.daily_digest ? `ON at ${settings.digest_time}` : 'OFF';
    bot.sendMessage(chatId, `Daily digest: *${status}*\n\nUsage: /digest on [HH:MM] | /digest off`, MD);
    return;
  }

  const toggle = args[0].toLowerCase();
  if (toggle === 'off') {
    setDailyDigest(String(chatId), false);
    bot.sendMessage(chatId, '✅ Daily digest turned off.');
    return;
  }

  if (toggle === 'on') {
    const time = args[1] || '08:00';
    if (!/^\d{2}:\d{2}$/.test(time)) {
      bot.sendMessage(chatId, 'Time format should be HH:MM (e.g., 08:00, 21:30)');
      return;
    }
    setDailyDigest(String(chatId), true, time);
    bot.sendMessage(chatId, `✅ Daily digest enabled at *${time}*`, MD);
    return;
  }

  bot.sendMessage(chatId, 'Usage: /digest on [HH:MM] | /digest off');
}

// --- Undo ---

export function handleUndo(bot, msg) {
  const chatId = msg.chat.id;
  const last = getLastDeactivated(String(chatId));

  if (!last) {
    bot.sendMessage(chatId, 'Nothing to undo.');
    return;
  }

  reactivateReminder(last.id);

  import('./scheduler.js').then(sched => {
    sched.scheduleReminder({ ...last, active: 1 });
  });

  bot.sendMessage(chatId, `↩️ Restored: "${last.text}"`);
}

// --- Repeat last ---

// Store last created reminder per chat
const lastCreated = new Map();

export function trackLastCreated(chatId, reminderData) {
  lastCreated.set(String(chatId), reminderData);
}

export function getLastCreated(chatId) {
  return lastCreated.get(String(chatId));
}

// --- Weekly summary ---

export function handleWeeklySummary(bot, msg) {
  const chatId = msg.chat.id;
  const stats = getWeeklyStats(String(chatId));
  const active = getActiveReminders(String(chatId));
  const total = stats.completed + stats.snoozed + stats.missed;

  let msg_ = '📊 *Weekly Summary*\n\n';
  msg_ += `✅ Completed: *${stats.completed}*\n`;
  msg_ += `⏰ Snoozed: *${stats.snoozed}*\n`;
  msg_ += `❌ Missed/ignored: *${stats.missed}*\n`;
  msg_ += `📝 Active: *${active.length}*\n\n`;

  if (total > 0) {
    const rate = Math.round((stats.completed / total) * 100);
    if (rate >= 80) msg_ += `🏆 Great job! ${rate}% completion rate!`;
    else if (rate >= 50) msg_ += `👍 ${rate}% completion rate. Keep it up!`;
    else msg_ += `💪 ${rate}% completion rate. You can do better!`;
  } else {
    msg_ += 'No reminders tracked this week. Set some reminders!';
  }

  bot.sendMessage(chatId, msg_, MD);
}
