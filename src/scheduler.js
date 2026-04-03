import cron from 'node-cron';
import {
  getAllActiveReminders,
  deactivateReminder,
  updateReminderTime,
  getActiveReminders,
  getTodaysReminders,
  getSettings,
  getWeeklyStats,
  markReminderFired,
  getIgnoredReminders,
} from './db.js';
import { buildContextualMessage } from './context.js';

// Track active timers/cron jobs so we can cancel them
const activeJobs = new Map(); // reminderId -> { timeout?, cron? }
let botInstance = null;

export function init(bot) {
  botInstance = bot;
}

function formatReminderMessage(reminder) {
  const categoryEmoji = {
    health: '🏥',
    work: '💼',
    personal: '🏠',
  };
  const emoji = categoryEmoji[reminder.category] || '⏰';
  return `${emoji} *Reminder:* ${reminder.text}`;
}

function buildSnoozeKeyboard(reminderId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '5 min', callback_data: `snooze:${reminderId}:5` },
          { text: '15 min', callback_data: `snooze:${reminderId}:15` },
          { text: '30 min', callback_data: `snooze:${reminderId}:30` },
          { text: '1 hour', callback_data: `snooze:${reminderId}:60` },
        ],
        [
          { text: 'Done', callback_data: `done:${reminderId}` },
        ],
      ],
    },
    parse_mode: 'Markdown',
  };
}

async function fireReminder(reminder) {
  if (!botInstance) return;

  // Context-aware message
  const settings = getSettings(reminder.chat_id);
  const message = buildContextualMessage(reminder.text, reminder.category, settings.timezone, reminder.notes);
  const options = buildSnoozeKeyboard(reminder.id);

  try {
    if (reminder.media_type === 'reply' && reminder.media_id) {
      // Reply to the original message (photo/media) so user sees it linked
      await botInstance.sendMessage(reminder.chat_id, message, {
        ...options,
        reply_to_message_id: parseInt(reminder.media_id, 10),
      });
    } else if (reminder.media_type === 'link' && reminder.media_id) {
      await botInstance.sendMessage(reminder.chat_id, `${message}\n\n${reminder.media_id}`, options);
    } else {
      await botInstance.sendMessage(reminder.chat_id, message, options);
    }
    markReminderFired(reminder.id);
  } catch (err) {
    // If reply fails (message deleted), send without reply
    try {
      await botInstance.sendMessage(reminder.chat_id, message, options);
      markReminderFired(reminder.id);
    } catch (err2) {
      console.error(`Failed to send reminder ${reminder.id}:`, err2.message);
    }
  }

  // If it's a one-off reminder, deactivate it
  if (!reminder.cron_expr) {
    deactivateReminder(reminder.id);
    activeJobs.delete(reminder.id);
  } else {
    // For recurring, update remind_at to next occurrence (cron handles scheduling)
    const nextRun = getNextCronDate(reminder.cron_expr);
    if (nextRun) {
      updateReminderTime(reminder.id, nextRun.toISOString());
    }
  }
}

function getNextCronDate(cronExpr) {
  // Simple next-run calculator for display purposes
  const now = new Date();
  const parts = cronExpr.split(' ');
  if (parts.length !== 5) return null;

  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);
  return next;
}

export function scheduleReminder(reminder) {
  cancelReminder(reminder.id);

  if (reminder.cron_expr) {
    // Recurring reminder via cron
    if (!cron.validate(reminder.cron_expr)) {
      console.error(`Invalid cron expression for reminder ${reminder.id}: ${reminder.cron_expr}`);
      return;
    }

    const job = cron.schedule(reminder.cron_expr, () => {
      fireReminder(reminder);
    });

    activeJobs.set(reminder.id, { cron: job });
  } else {
    // One-off reminder via setTimeout
    const remindAt = new Date(reminder.remind_at);
    const delay = remindAt.getTime() - Date.now();

    if (delay <= 0) {
      // Already past due — fire immediately
      fireReminder(reminder);
      return;
    }

    const timeout = setTimeout(() => {
      fireReminder(reminder);
    }, delay);

    activeJobs.set(reminder.id, { timeout });
  }
}

export function cancelReminder(reminderId) {
  const job = activeJobs.get(reminderId);
  if (!job) return;

  if (job.timeout) clearTimeout(job.timeout);
  if (job.cron) job.cron.stop();
  activeJobs.delete(reminderId);
}

export function snoozeReminder(reminderId, minutes) {
  cancelReminder(reminderId);

  const newTime = new Date(Date.now() + minutes * 60 * 1000);
  const reminder = { id: reminderId, remind_at: newTime.toISOString(), cron_expr: null };

  // Re-fetch the full reminder to get the text for firing
  const full = getAllActiveReminders().find(r => r.id === reminderId);
  if (full) {
    full.remind_at = newTime.toISOString();
    full.cron_expr = null; // snooze is always one-off
    scheduleReminder(full);
  }
}

/**
 * Load all active reminders from DB and schedule them.
 * Called on bot startup.
 */
export function loadAllReminders() {
  const reminders = getAllActiveReminders();
  let scheduled = 0;
  let pastDue = 0;

  for (const reminder of reminders) {
    if (reminder.cron_expr) {
      scheduleReminder(reminder);
      scheduled++;
    } else {
      const remindAt = new Date(reminder.remind_at);
      if (remindAt <= new Date()) {
        // Past due — fire immediately
        fireReminder(reminder);
        pastDue++;
      } else {
        scheduleReminder(reminder);
        scheduled++;
      }
    }
  }

  console.log(`Loaded ${scheduled} scheduled reminders, ${pastDue} fired immediately (past due)`);
}

/**
 * Schedule daily digest cron jobs for all users who have it enabled.
 */
export function setupDailyDigest() {
  // Check for ignored reminders every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    if (!botInstance) return;

    const allReminders = getAllActiveReminders();
    const chatIds = [...new Set(allReminders.map(r => r.chat_id))];

    for (const chatId of chatIds) {
      const ignored = getIgnoredReminders(chatId);
      if (ignored.length === 0) continue;

      let msg = '🔔 *Ignored Reminders*\n\nThese reminders have been firing for 3+ days without response:\n\n';
      for (const r of ignored) {
        msg += `*#${r.id}* ${r.text}\n`;
      }
      msg += '\nWant to /cancel them or /pause all reminders?';

      try {
        await botInstance.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error(`Failed to send ignored alert to ${chatId}:`, err.message);
      }
    }
  });

  // Check every minute if any digest needs to be sent
  cron.schedule('* * * * *', async () => {
    if (!botInstance) return;

    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const dateStr = now.toISOString().split('T')[0];

    // This is a simple approach — for production you'd query settings more efficiently
    const allReminders = getAllActiveReminders();
    const chatIds = [...new Set(allReminders.map(r => r.chat_id))];

    for (const chatId of chatIds) {
      const settings = getSettings(chatId);
      if (!settings.daily_digest) continue;
      if (settings.digest_time !== currentTime) continue;

      const todaysReminders = getTodaysReminders(chatId, dateStr);
      if (todaysReminders.length === 0) continue;

      let message = '📋 *Today\'s Reminders:*\n\n';
      todaysReminders.forEach((r, i) => {
        const time = new Date(r.remind_at).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        });
        message += `${i + 1}. ${time} — ${r.text}\n`;
      });

      try {
        await botInstance.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error(`Failed to send digest to ${chatId}:`, err.message);
      }
    }
  });

  // Weekly summary — every Sunday at 9pm
  cron.schedule('0 21 * * 0', async () => {
    if (!botInstance) return;

    const allReminders = getAllActiveReminders();
    const chatIds = [...new Set(allReminders.map(r => r.chat_id))];

    for (const chatId of chatIds) {
      const stats = getWeeklyStats(chatId);
      const active = getActiveReminders(chatId);
      const total = stats.completed + stats.snoozed + stats.missed;
      if (total === 0) continue;

      const rate = Math.round((stats.completed / total) * 100);
      let emoji = '💪';
      if (rate >= 80) emoji = '🏆';
      else if (rate >= 50) emoji = '👍';

      const msg = `📊 *Weekly Summary*\n\n` +
        `✅ Completed: *${stats.completed}*\n` +
        `⏰ Snoozed: *${stats.snoozed}*\n` +
        `❌ Missed: *${stats.missed}*\n` +
        `📝 Active: *${active.length}*\n\n` +
        `${emoji} ${rate}% completion rate. Keep it up!`;

      try {
        await botInstance.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error(`Failed to send weekly summary to ${chatId}:`, err.message);
      }
    }
  });
}
