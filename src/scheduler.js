import cron from 'node-cron';
import {
  getAllActiveReminders, getActiveChatIds, isSchedulable,
  deactivateReminder,
  updateReminderTime,
  getActiveReminders,
  getTodaysReminders,
  getSettings,
  getWeeklyStats,
  markReminderFired,
  getIgnoredReminders,
  incrementFireCount,
  getFireCount,
  resetFireCount,
  getReminder,
  getStreak,
} from './db.js';

// Fetch weather from wttr.in (free, no API key)
async function fetchWeather(location) {
  if (!location) return null;
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const current = data.current_condition?.[0];
    if (!current) return null;
    return {
      temp: current.temp_C,
      desc: current.weatherDesc?.[0]?.value || '',
      feelsLike: current.FeelsLikeC,
    };
  } catch { return null; }
}
import { buildContextualMessage } from './context.js';

// Track active timers/cron jobs so we can cancel them
const activeJobs = new Map(); // reminderId -> { timeout?, cron? }
let botInstance = null;

// Map bot message IDs to reminder IDs (for reply-to feature)
// Map bot message IDs to reminder IDs — capped at 500 entries to prevent memory leak
export const messageReminderMap = new Map();
function addToMessageMap(msgId, reminderId) {
  messageReminderMap.set(msgId, reminderId);
  if (messageReminderMap.size > 500) {
    // Delete oldest entries (first 100)
    const keys = [...messageReminderMap.keys()].slice(0, 100);
    keys.forEach(k => messageReminderMap.delete(k));
  }
}

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

function buildSnoozeKeyboard(reminderId, snoozeCount = 0) {
  // After 3+ snoozes, offer smart options instead of normal snooze
  if (snoozeCount >= 3) {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Tomorrow 9am', callback_data: `reschedule_tomorrow:${reminderId}` },
            { text: 'Drop it', callback_data: `drop:${reminderId}` },
          ],
          [
            { text: '1 hour', callback_data: `snooze:${reminderId}:60` },
            { text: 'Done', callback_data: `done:${reminderId}` },
          ],
        ],
      },
      parse_mode: 'Markdown',
    };
  }

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

// Reminder ids currently being fired — dedups the setTimeout-vs-missed-cron race
// where both trigger before markReminderFired commits, causing a duplicate send.
const firingNow = new Set();
async function fireReminder(reminder) {
  if (firingNow.has(reminder.id)) return; // already firing this reminder — skip the duplicate
  firingNow.add(reminder.id);
  try {
    await _fireReminder(reminder);
  } finally {
    firingNow.delete(reminder.id);
  }
}

async function _fireReminder(reminder) {
  if (!botInstance) return;

  // Context-aware message
  const settings = await getSettings(reminder.chat_id);

  // Quiet hours: hold non-urgent reminders until the window ends.
  if (reminder.priority !== 'urgent') {
    const { isQuietNow, quietRemainingMs } = await import('./quiet.js');
    if (isQuietNow(settings)) {
      const delayMs = quietRemainingMs(settings);
      if (reminder.cron_expr) {
        const t = setTimeout(async () => {
          try { const fresh = await getReminder(reminder.id); if (fresh && fresh.active === 1) fireReminder(fresh); }
          catch (e) { console.error('[Quiet catch-up]', e.message); }
        }, delayMs);
        activeJobs.set(`quiet:${reminder.id}`, { timeout: t });
      } else {
        await updateReminderTime(reminder.id, new Date(Date.now() + delayMs).toISOString());
      }
      console.log(`[Quiet] Held reminder ${reminder.id} ~${Math.round(delayMs / 60000)}min until quiet-end`);
      return;
    }
  }

  let message = buildContextualMessage(reminder.text, reminder.category, settings.timezone, reminder.notes, reminder.priority);

  // Surface no-time list items alongside every reminder (capped).
  try {
    const { getNoTimeReminders } = await import('./db.js');
    const noTime = await getNoTimeReminders(reminder.chat_id);
    if (noTime.length > 0) {
      message += `\n\n———\n📝 *On your list (no time):*${noTime.slice(0, 10).map(r => `\n  • ${r.text}`).join('')}`;
      if (noTime.length > 10) message += `\n  …and ${noTime.length - 10} more — say "list"`;
    }
  } catch (e) { console.error('[Fire] no-time append:', e.message); }
  const options = buildSnoozeKeyboard(reminder.id, reminder.snooze_count || 0);

  try {
    let sentMsg;
    if (reminder.media_type === 'reply' && reminder.media_id) {
      // Reply to the original message (photo/media) so user sees it linked
      sentMsg = await botInstance.sendMessage(reminder.chat_id, message, {
        ...options,
        reply_to_message_id: parseInt(reminder.media_id, 10),
      });
    } else if (reminder.media_type === 'link' && reminder.media_id) {
      sentMsg = await botInstance.sendMessage(reminder.chat_id, `${message}\n\n${reminder.media_id}`, options);
    } else {
      sentMsg = await botInstance.sendMessage(reminder.chat_id, message, options);
    }
    if (sentMsg) addToMessageMap(sentMsg.message_id, reminder.id);
    await markReminderFired(reminder.id);
  } catch (err) {
    // If reply fails (message deleted), send without reply
    try {
      const sentMsg = await botInstance.sendMessage(reminder.chat_id, message, options);
      if (sentMsg) addToMessageMap(sentMsg.message_id, reminder.id);
      await markReminderFired(reminder.id);
    } catch (err2) {
      console.error(`Failed to send reminder ${reminder.id}:`, err2.message);
    }
  }

  // Send to shared recipients
  if (reminder.shared_with) {
    try {
      const sharedIds = JSON.parse(reminder.shared_with);
      for (const recipientId of sharedIds) {
        try {
          await botInstance.sendMessage(recipientId, `*Shared reminder:* ${message}`, { parse_mode: 'Markdown' });
        } catch (e) { console.error(`Failed to send shared reminder to ${recipientId}:`, e.message); }
      }
    } catch {}
  }

  // Urgent reminders: re-fire every 5 min up to 3 times if no response
  if (reminder.priority === 'urgent') {
    await incrementFireCount(reminder.id);
    const fireCount = await getFireCount(reminder.id);
    if (fireCount < 3) {
      const refireTimeout = setTimeout(async () => {
        try {
          const fresh = await getReminder(reminder.id);
          if (fresh && fresh.active === 1) await fireReminder(fresh);
        } catch (e) { console.error(`[Refire] Error reminder ${reminder.id}:`, e.message); }
      }, 5 * 60 * 1000);
      activeJobs.set(`refire:${reminder.id}`, { timeout: refireTimeout });
    }
  }

  // If it's a one-off reminder, deactivate it
  if (!reminder.cron_expr) {
    await deactivateReminder(reminder.id);
    activeJobs.delete(reminder.id);
  } else {
    // For recurring, update remind_at to next occurrence (cron handles scheduling)
    const nextRun = getNextCronDate(reminder.cron_expr);
    if (nextRun) {
      await updateReminderTime(reminder.id, nextRun.toISOString());
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

  // No-time reminders (remind_at NULL) are never scheduled — they live in the list only.
  if (!isSchedulable(reminder)) return;

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

    // Cap delay at 24 days to prevent Node.js setTimeout overflow (>2^31ms fires immediately)
    // Reminders further out will be picked up by the missed-check cron when they become due
    const MAX_TIMEOUT = 24 * 24 * 60 * 60 * 1000; // 24 days
    const safeDelay = Math.min(delay, MAX_TIMEOUT);
    const timeout = setTimeout(async () => {
      try {
        if (safeDelay < delay) {
          // Re-check if actually due now (was capped, might not be time yet)
          const fresh = await getReminder(reminder.id);
          if (fresh && new Date(fresh.remind_at).getTime() > Date.now()) {
            scheduleReminder(fresh); // Reschedule for another 24-day window
            return;
          }
        }
        await fireReminder(reminder);
      } catch (e) { console.error(`[Fire] Error reminder ${reminder.id}:`, e.message); }
    }, safeDelay);

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

export async function snoozeReminder(reminderId, minutes) {
  cancelReminder(reminderId);

  const newTime = new Date(Date.now() + minutes * 60 * 1000);
  const reminder = { id: reminderId, remind_at: newTime.toISOString(), cron_expr: null };

  // Re-fetch the full reminder to get the text for firing
  const allActive = await getAllActiveReminders();
  const full = allActive.find(r => r.id === reminderId);
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
export async function loadAllReminders() {
  const reminders = await getAllActiveReminders();
  let scheduled = 0;
  let pastDue = 0;

  for (const reminder of reminders) {
    if (!isSchedulable(reminder)) {
      continue; // no-time reminder — not scheduled
    } else if (reminder.cron_expr) {
      scheduleReminder(reminder);
      scheduled++;
    } else {
      const remindAt = new Date(reminder.remind_at);
      if (remindAt <= new Date()) {
        // Past due — mark as fired first (prevents missed-check cron from double-firing)
        await markReminderFired(reminder.id);
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
  // Idle check-in — every 12 hours, check for users who haven't messaged in 2+ days
  cron.schedule('0 */12 * * *', async () => {
    if (!botInstance) return;
    try {
      const { getLastMessageTime } = await import('./db.js');
      const chatIds = (await getActiveChatIds()).filter(id => !(id.length >= 10 && /^\d+$/.test(id)));
      for (const chatId of chatIds) {
        const lastMsg = await getLastMessageTime(chatId);
        if (!lastMsg) continue;
        const hoursSince = (Date.now() - new Date(lastMsg).getTime()) / 3600000;
        if (hoursSince >= 48 && hoursSince < 60) { // Between 2-2.5 days
          const active = await getActiveReminders(chatId);
          if (active.length > 0) {
            botInstance.sendMessage(chatId, `Hey! You have *${active.length}* pending reminder${active.length > 1 ? 's' : ''}. Need anything?`, { parse_mode: 'Markdown' }).catch(e => console.error("[Send]", e.message));
          }
        }
      }
    } catch (err) { console.error('[Idle Check]', err.message); }
  });

  // Follow-up check — every 6 hours, notify about due follow-ups
  cron.schedule('0 */6 * * *', async () => {
    if (!botInstance) return;
    try {
      const { getDueFollowups } = await import('./db.js');
      const chatIds = (await getActiveChatIds()).filter(id => !(id.length >= 10 && /^\d+$/.test(id)));
      for (const chatId of chatIds) {
        const due = await getDueFollowups(chatId);
        for (const f of due) {
          botInstance.sendMessage(chatId, `*Follow-up due:* ${f.person} — ${f.subject}\nSay "followup ${f.id} done" when resolved.`, { parse_mode: 'Markdown' }).catch(e => console.error("[Send]", e.message));
        }
      }
    } catch (err) { console.error('[Follow-up Check]', err.message); }
  });

  // End-of-day recap — 9pm daily
  cron.schedule('0 21 * * 1-6', async () => { // Mon-Sat (Sunday has weekly summary)
    if (!botInstance) return;
    try {
      const chatIds = (await getActiveChatIds()).filter(id => !(id.length >= 10 && /^\d+$/.test(id)));
      for (const chatId of chatIds) {
        const settings = await getSettings(chatId);
        if (!settings.daily_digest) continue;
        const active = await getActiveReminders(chatId);
        const { getExpenseSummary } = await import('./db.js');
        const todaySpend = await getExpenseSummary(chatId, 1);
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: settings.timezone });
        const { getTodaysReminders } = await import('./db.js');
        const tomorrowRems = await getTodaysReminders(chatId, tomorrowStr);

        // Activity: what was added / completed / cancelled today
        const { getActivitySummary } = await import('./db.js');
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const activity = await getActivitySummary(chatId, todayStart.toISOString());

        let msg = '*📰 Daily Recap*\n';
        const totalAct = activity.added.length + activity.completed.length + activity.cancelled.length;
        if (totalAct > 0) {
          msg += `\n*Today's reminders:*`;
          msg += `\n  📅 Added: ${activity.added.length}  ✅ Completed: ${activity.completed.length}  ❌ Cancelled: ${activity.cancelled.length}`;
          if (activity.added.length > 0) {
            msg += `\n\n*Added:*`;
            for (const r of activity.added.slice(0, 5)) msg += `\n  • ${r.text}`;
            if (activity.added.length > 5) msg += `\n  …+${activity.added.length - 5} more`;
          }
          if (activity.completed.length > 0) {
            msg += `\n\n*Completed:*`;
            for (const r of activity.completed.slice(0, 5)) msg += `\n  • ${r.text}`;
            if (activity.completed.length > 5) msg += `\n  …+${activity.completed.length - 5} more`;
          }
          if (activity.cancelled.length > 0) {
            msg += `\n\n*Cancelled:*`;
            for (const r of activity.cancelled.slice(0, 5)) msg += `\n  • ${r.text}`;
            if (activity.cancelled.length > 5) msg += `\n  …+${activity.cancelled.length - 5} more`;
          }
        }

        if (todaySpend.count > 0) msg += `\n\nSpent today: *${todaySpend.total.toFixed(2)}* (${todaySpend.count} transactions)`;
        msg += `\nStill pending: *${active.length}*`;
        if (tomorrowRems.length > 0) {
          msg += `\n\n*Tomorrow (${tomorrowRems.length}):*`;
          for (const r of tomorrowRems) {
            const time = new Date(r.remind_at).toLocaleTimeString('en-US', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', hour12: true });
            msg += `\n  ${time} — ${r.text}`;
          }
        } else {
          msg += '\n\nNothing scheduled for tomorrow.';
        }

        // Business signals: unusual category spend + aging follow-ups.
        try {
          const { getExpensesByCategory, getPendingFollowups } = await import('./db.js');
          const { expenseAnomalies, agingFollowups, businessSignalsSection } = await import('./insights.js');
          const signals = businessSignalsSection(
            expenseAnomalies(await getExpensesByCategory(chatId, 7), await getExpensesByCategory(chatId, 35)),
            agingFollowups(await getPendingFollowups(chatId)),
          );
          if (signals) msg += signals;
        } catch (e) { console.error('[EOD Signals]', e.message); }

        msg += '\n\nGood night!';
        botInstance.sendMessage(chatId, msg, { parse_mode: 'Markdown' }).catch(e => console.error("[Send]", e.message));
      }
    } catch (err) { console.error('[EOD Recap]', err.message); }
  });

  // Week planning — Sunday 7pm
  cron.schedule('0 19 * * 0', async () => {
    if (!botInstance) return;
    try {
      const chatIds = (await getActiveChatIds()).filter(id => !(id.length >= 10 && /^\d+$/.test(id)));
      for (const chatId of chatIds) {
        const settings = await getSettings(chatId);
        if (!settings.daily_digest) continue;
        const active = await getActiveReminders(chatId);
        const { getExpenseSummary, getPendingFollowups } = await import('./db.js');
        const weekSpend = await getExpenseSummary(chatId, 7);
        const followups = await getPendingFollowups(chatId);

        // Group reminders by day
        const days = {};
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        for (const r of active) {
          if (!r.remind_at || r.cron_expr) continue; // skip no-time / recurring rows
          const d = new Date(r.remind_at);
          const key = d.toLocaleDateString('en-CA', { timeZone: settings.timezone });
          if (!days[key]) days[key] = [];
          days[key].push(r);
        }

        let msg = '*Week Ahead*\n';
        const sortedDays = Object.keys(days).sort().slice(0, 7);
        for (const day of sortedDays) {
          const d = new Date(day);
          msg += `\n*${dayNames[d.getDay()]}, ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}:*`;
          for (const r of days[day]) {
            const time = new Date(r.remind_at).toLocaleTimeString('en-US', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', hour12: true });
            msg += `\n  ${time} — ${r.text}`;
          }
        }
        if (weekSpend.count > 0) msg += `\n\nLast week spending: *${weekSpend.total.toFixed(2)}*`;
        if (followups.length > 0) msg += `\n\nPending follow-ups: *${followups.length}*`;
        msg += '\n\nHave a great week!';
        botInstance.sendMessage(chatId, msg, { parse_mode: 'Markdown' }).catch(e => console.error("[Send]", e.message));
      }
    } catch (err) { console.error('[Week Planning]', err.message); }
  });

  // Auto-log recurring expenses at midnight
  cron.schedule('0 0 * * *', async () => {
    try {
      const { getActiveRecurringExpenses, addExpense } = await import('./db.js');
      const today = new Date().getDate();
      const recurring = await getActiveRecurringExpenses();
      for (const r of recurring) {
        if (r.cron_day === today) {
          await addExpense(r.chat_id, r.amount, r.description, r.category, r.currency);
          console.log(`[Recurring] Auto-logged ${r.amount} ${r.currency} — ${r.description} for ${r.chat_id}`);
        }
      }
    } catch (err) { console.error('[Recurring Expense]', err.message); }
  });

  // Daily cleanup at 3am — remove stale data
  cron.schedule('0 3 * * *', async () => {
    try {
      const {
        cleanupStaleReminders, purgeOldReminders,
        purgeOldCompletedReminders, purgeOldChatHistory, purgeOldExpenses,
      } = await import('./db.js');

      const stale = await cleanupStaleReminders();
      const purgedRem = await purgeOldReminders();
      const purgedComp = await purgeOldCompletedReminders();
      const purgedChat = await purgeOldChatHistory();
      const purgedExp = await purgeOldExpenses();

      if (stale || purgedRem || purgedComp || purgedChat || purgedExp) {
        console.log(`[Cleanup] Stale reminders deactivated: ${stale}, Old reminders purged: ${purgedRem}, Old completed purged: ${purgedComp}, Old chat purged: ${purgedChat}, Old expenses purged: ${purgedExp}`);
      }
    } catch (err) {
      console.error('[Cleanup] Error:', err.message);
    }
  });

  // Check for upcoming birthdays daily at 8am
  cron.schedule('0 8 * * *', async () => {
    if (!botInstance) return;
    try {
      const { getUpcomingBirthdays } = await import('./db.js');
      // Check all users (Telegram only — non-phone-number IDs)
      const chatIds = (await getActiveChatIds()).filter(id => !(id.length >= 10 && /^\d+$/.test(id)));
      const today = new Date();

      for (const chatId of chatIds) {
        const contacts = await getUpcomingBirthdays(chatId);
        for (const c of contacts) {
          if (!c.birthday) continue;
          // Check if birthday is today or in 3 days
          const bday = c.birthday; // format: MM-DD
          const bdayDate = new Date(today.getFullYear(), parseInt(bday.split('-')[0]) - 1, parseInt(bday.split('-')[1]));
          if (bdayDate < today) bdayDate.setFullYear(today.getFullYear() + 1);
          const daysUntil = Math.ceil((bdayDate - today) / 86400000);
          if (daysUntil === 0) {
            botInstance.sendMessage(chatId, `🎂 *${c.name}'s birthday is today!*`).catch(e => console.error("[Send]", e.message));
          } else if (daysUntil === 3) {
            botInstance.sendMessage(chatId, `🎂 *${c.name}'s birthday is in 3 days* (${bday})`).catch(e => console.error("[Send]", e.message));
          }
        }
      }
    } catch (err) { console.error('[Birthday Check]', err.message); }
  });

  // Catch missed reminders every 2 minutes — fires any past-due reminders that were never sent
  cron.schedule('*/2 * * * *', async () => {
    if (!botInstance) return;
    try {
      const { getMissedReminders } = await import('./db.js');
      const missed = await getMissedReminders();
      // Only fire Telegram reminders (non-phone-number chat IDs)
      const telegramMissed = missed.filter(r => !(r.chat_id.length >= 10 && /^\d+$/.test(r.chat_id)));
      for (const reminder of telegramMissed) {
        console.log(`[Missed Check] Firing missed reminder ${reminder.id}: "${reminder.text}"`);
        fireReminder(reminder);
      }
    } catch (err) {
      console.error('[Missed Check] Error:', err.message);
    }
  });

  // Check for ignored reminders every 6 hours (Telegram users only — phone-number IDs are WhatsApp)
  cron.schedule('0 */6 * * *', async () => {
    if (!botInstance) return;

    const chatIds = (await getActiveChatIds()).filter(id => !(id.length >= 10 && /^\d+$/.test(id)));

    for (const chatId of chatIds) {
      const ignored = await getIgnoredReminders(chatId);
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

    // Query only users whose digest is due right now (instead of fetching ALL users every minute)
    const { getDigestUsers } = await import('./db.js');
    const digestUsers = await getDigestUsers(currentTime);
    // Filter to Telegram users only (non-phone-number IDs)
    const chatIds = digestUsers.filter(u => !(u.chat_id.length >= 10 && /^\d+$/.test(u.chat_id))).map(u => u.chat_id);

    for (const chatId of chatIds) {
      const settings = await getSettings(chatId);

      const todaysReminders = await getTodaysReminders(chatId, dateStr);
      if (todaysReminders.length === 0) continue;

      // Build morning briefing
      let message = '*Good morning!*\n';

      // Weather if location set
      const weather = await fetchWeather(settings.location);
      if (weather) {
        message += `\n${weather.temp}°C, ${weather.desc}`;
        if (weather.feelsLike !== weather.temp) message += ` (feels ${weather.feelsLike}°C)`;
        message += '\n';
      }

      const letters = 'abcdefghijklmnopqrstuvwxyz';
      message += `\nToday you have ${todaysReminders.length} reminder${todaysReminders.length === 1 ? '' : 's'}:\n`;
      for (let i = 0; i < todaysReminders.length; i++) {
        const r = todaysReminders[i];
        const time = new Date(r.remind_at).toLocaleTimeString('en-US', {
          timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', hour12: true,
        });
        const priorityTag = r.priority === 'urgent' ? ' *URGENT*' : '';
        message += `\n  *${letters[i]})* ${time} — ${r.text}${priorityTag}`;
        if (r.notes) message += `\n     Note: ${r.notes}`;
        // Show streak if recurring
        if (r.cron_expr) {
          const streak = await getStreak(chatId, r.text);
          if (streak?.current_streak > 1) message += `\n     Streak: ${streak.current_streak} days`;
        }
      }

      // Yesterday's spending
      try {
        const { getExpenseSummary } = await import('./db.js');
        const recent = await getExpenseSummary(chatId, 1);
        if (recent.count > 0) message += `\n\nLast 24h spending: *${recent.total.toFixed(2)}* (${recent.count} transactions)`;
        // Weekly insight — compare this week vs last week
        const thisWeek = await getExpenseSummary(chatId, 7);
        const lastWeek = await getExpenseSummary(chatId, 14);
        if (thisWeek.total > 0 && lastWeek.total > thisWeek.total) {
          const lastWeekOnly = lastWeek.total - thisWeek.total;
          if (lastWeekOnly > 0) {
            const pctChange = Math.round(((thisWeek.total - lastWeekOnly) / lastWeekOnly) * 100);
            if (pctChange > 20) message += `\n⬆️ Spending up ${pctChange}% vs last week`;
            else if (pctChange < -20) message += `\n⬇️ Spending down ${Math.abs(pctChange)}% vs last week`;
          }
        }
      } catch {}

      // Upcoming birthdays
      try {
        const { getUpcomingBirthdays } = await import('./db.js');
        const contacts = await getUpcomingBirthdays(chatId);
        const today = new Date();
        const upcoming = contacts.filter(c => {
          if (!c.birthday) return false;
          const [m, d] = c.birthday.split('-').map(Number);
          const bd = new Date(today.getFullYear(), m - 1, d);
          if (bd < today) bd.setFullYear(today.getFullYear() + 1);
          const diff = Math.ceil((bd - today) / 86400000);
          return diff >= 0 && diff <= 7;
        });
        if (upcoming.length > 0) {
          message += '\n\nUpcoming birthdays:';
          for (const c of upcoming) message += `\n  🎂 ${c.name} (${c.birthday})`;
        }
      } catch {}

      message += '\n\nHave a good day!';

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

    const chatIds = await getActiveChatIds();

    for (const chatId of chatIds) {
      // Only Telegram chat ids
      if (chatId.length >= 10 && /^\d+$/.test(chatId)) continue;
      const stats = await getWeeklyStats(chatId);
      const active = await getActiveReminders(chatId);
      const { getActivitySummary } = await import('./db.js');
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const activity = await getActivitySummary(chatId, weekAgo);

      const total = activity.added.length + activity.completed.length + activity.cancelled.length;
      if (total === 0 && stats.completed + stats.snoozed + stats.missed === 0) continue;

      const rate = stats.completed + stats.missed > 0
        ? Math.round((stats.completed / (stats.completed + stats.missed)) * 100)
        : 100;
      let emoji = '💪';
      if (rate >= 80) emoji = '🏆';
      else if (rate >= 50) emoji = '👍';

      let msg = `📊 *Weekly Summary*\n\n`;
      msg += `*This week:*\n`;
      msg += `  📅 Added: *${activity.added.length}*\n`;
      msg += `  ✅ Completed: *${activity.completed.length}*\n`;
      msg += `  ❌ Cancelled: *${activity.cancelled.length}*\n`;
      if (stats.snoozed > 0) msg += `  ⏰ Snoozed: *${stats.snoozed}*\n`;
      if (stats.missed > 0) msg += `  ⚠️ Missed: *${stats.missed}*\n`;
      msg += `  📋 Still pending: *${active.length}*\n`;

      if (activity.added.length > 0) {
        msg += `\n*Added (${activity.added.length}):*`;
        for (const r of activity.added.slice(0, 7)) msg += `\n  • ${r.text}`;
        if (activity.added.length > 7) msg += `\n  …+${activity.added.length - 7} more`;
      }
      if (activity.completed.length > 0) {
        msg += `\n\n*Completed (${activity.completed.length}):*`;
        for (const r of activity.completed.slice(0, 7)) msg += `\n  • ${r.text}`;
        if (activity.completed.length > 7) msg += `\n  …+${activity.completed.length - 7} more`;
      }
      if (activity.cancelled.length > 0) {
        msg += `\n\n*Cancelled (${activity.cancelled.length}):*`;
        for (const r of activity.cancelled.slice(0, 7)) msg += `\n  • ${r.text}`;
        if (activity.cancelled.length > 7) msg += `\n  …+${activity.cancelled.length - 7} more`;
      }

      msg += `\n\n${emoji} ${rate}% completion rate. Keep it up!`;

      try {
        await botInstance.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error(`Failed to send weekly summary to ${chatId}:`, err.message);
      }
    }
  });

  // Google Calendar sync — every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { isConfigured, syncFromCalendar } = await import('./google-calendar.js');
      if (!isConfigured()) return;
      const { getUsersWithGoogleTokens } = await import('./db.js');
      const users = await getUsersWithGoogleTokens();
      for (const user of users) {
        // Only Telegram users (non-phone-number chat IDs)
        if (user.chat_id.length >= 10 && /^\d+$/.test(user.chat_id)) continue;
        const created = await syncFromCalendar(user.chat_id, scheduleReminder);
        if (created.length > 0 && botInstance) {
          botInstance.sendMessage(user.chat_id,
            `Synced ${created.length} event${created.length === 1 ? '' : 's'} from Calendar:\n${created.map(e => `- ${e}`).join('\n')}`,
          ).catch(e => console.error("[Send]", e.message));
        }
      }
    } catch (err) {
      console.error('[GCal Sync] Error:', err.message);
    }
  });

  // URL monitor check — every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    if (!botInstance) return;
    try {
      const { checkAllMonitors } = await import('./url-monitor.js');
      const alerts = await checkAllMonitors();
      for (const alert of alerts) {
        const label = alert.monitor.label || alert.monitor.url;
        const msg = `*URL Alert: ${label}*\n${alert.details}\n${alert.monitor.url}`;
        try {
          await botInstance.sendMessage(alert.monitor.chat_id, msg, { parse_mode: 'Markdown' });
        } catch (err) {
          console.error(`Failed to send URL alert to ${alert.monitor.chat_id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[URL Monitor] Check failed:', err.message);
    }
  });
}
