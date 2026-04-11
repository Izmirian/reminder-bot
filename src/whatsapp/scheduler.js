/**
 * WhatsApp-specific scheduler — reuses the same DB but sends via WhatsApp API.
 */
import cron from 'node-cron';
import { sendReminderMessage, sendTextMessage, sendImageMessage, uploadMedia } from './api.js';
import {
  getAllActiveReminders,
  deactivateReminder,
  updateReminderTime,
  getTodaysReminders,
  getSettings,
  markReminderFired,
  getIgnoredReminders,
  incrementFireCount,
  getFireCount,
  getReminder,
  getStreak,
} from '../db.js';
import { buildContextualMessage } from '../context.js';

const activeJobs = new Map();

// Map WhatsApp message IDs (wamid) to reminder IDs (for reply-to feature)
export const messageReminderMap = new Map(); // wamid -> reminderId

function getNextCronDate() {
  const next = new Date();
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);
  return next;
}

async function fireReminder(reminder) {
  try {
    const settings = await getSettings(reminder.chat_id);
    const contextMsg = buildContextualMessage(reminder.text, reminder.category, settings.timezone, reminder.notes, reminder.priority);

    // Send image if attached — upload from stored binary, then send
    console.log(`[WA Fire] id=${reminder.id} media_type=${reminder.media_type} has_data=${!!reminder.media_data} data_len=${reminder.media_data?.length || 0}`);
    let apiResult;
    if (reminder.media_type === 'wa_image' && reminder.media_data) {
      try {
        const mimeType = reminder.media_id || 'image/jpeg'; // media_id stores mime type
        const freshMediaId = await uploadMedia(reminder.media_data, mimeType);
        if (freshMediaId) {
          apiResult = await sendImageMessage(reminder.chat_id, freshMediaId, contextMsg);
        } else {
          apiResult = await sendReminderMessage(reminder.chat_id, contextMsg + '\n(photo could not be loaded)', reminder.id, reminder.snooze_count || 0);
        }
      } catch (imgErr) {
        console.error(`[WhatsApp] Failed to send image for reminder ${reminder.id}:`, imgErr.message);
        apiResult = await sendReminderMessage(reminder.chat_id, contextMsg, reminder.id, reminder.snooze_count || 0);
      }
    } else {
      apiResult = await sendReminderMessage(reminder.chat_id, contextMsg, reminder.id, reminder.snooze_count || 0);
    }
    // Track message ID for reply-to feature
    const wamid = apiResult?.messages?.[0]?.id;
    if (wamid) messageReminderMap.set(wamid, reminder.id);
    await markReminderFired(reminder.id);
  } catch (err) {
    console.error(`[WhatsApp] Failed to send reminder ${reminder.id}:`, err.message);
  }

  // Send to shared recipients
  if (reminder.shared_with) {
    try {
      const sharedIds = JSON.parse(reminder.shared_with);
      for (const recipientId of sharedIds) {
        try {
          await sendTextMessage(recipientId, `*Shared reminder:* ${contextMsg}`);
        } catch (e) { console.error(`[WhatsApp] Failed shared reminder to ${recipientId}:`, e.message); }
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
        } catch (e) { console.error(`[WA Refire] Error:`, e.message); }
      }, 5 * 60 * 1000);
      activeJobs.set(`refire:${reminder.id}`, { timeout: refireTimeout });
    }
  }

  if (!reminder.cron_expr) {
    await deactivateReminder(reminder.id);
    activeJobs.delete(reminder.id);
  } else {
    const nextRun = getNextCronDate();
    await updateReminderTime(reminder.id, nextRun.toISOString());
  }
}

export function scheduleReminder(reminder) {
  cancelReminder(reminder.id);

  if (reminder.cron_expr) {
    if (!cron.validate(reminder.cron_expr)) {
      console.error(`[WhatsApp] Invalid cron for reminder ${reminder.id}: ${reminder.cron_expr}`);
      return;
    }
    const job = cron.schedule(reminder.cron_expr, () => fireReminder(reminder));
    activeJobs.set(reminder.id, { cron: job });
  } else {
    const delay = new Date(reminder.remind_at).getTime() - Date.now();
    if (delay <= 0) {
      fireReminder(reminder);
      return;
    }
    const timeout = setTimeout(async () => {
      try { await fireReminder(reminder); } catch (e) { console.error(`[WA Fire] Error:`, e.message); }
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

export function cancelAllReminders(chatId) {
  for (const [id, job] of activeJobs.entries()) {
    if (job.timeout) clearTimeout(job.timeout);
    if (job.cron) job.cron.stop();
    activeJobs.delete(id);
  }
}

export async function snoozeReminder(reminderId, minutes) {
  cancelReminder(reminderId);
  const newTime = new Date(Date.now() + minutes * 60 * 1000);
  const allActive = await getAllActiveReminders();
  const full = allActive.find(r => r.id === reminderId);
  if (full) {
    full.remind_at = newTime.toISOString();
    full.cron_expr = null;
    scheduleReminder(full);
  }
}

/**
 * Load all active WhatsApp reminders (chat_id is a phone number, not a Telegram numeric ID).
 */
export async function loadWhatsAppReminders() {
  const reminders = await getAllActiveReminders();
  // WhatsApp chat_ids are phone numbers (digits, 10+ chars)
  const waReminders = reminders.filter(r => r.chat_id.length >= 10 && /^\d+$/.test(r.chat_id));

  let scheduled = 0;
  let pastDue = 0;

  for (const reminder of waReminders) {
    if (reminder.cron_expr) {
      scheduleReminder(reminder);
      scheduled++;
    } else {
      if (new Date(reminder.remind_at) <= new Date()) {
        fireReminder(reminder);
        pastDue++;
      } else {
        scheduleReminder(reminder);
        scheduled++;
      }
    }
  }

  console.log(`[WhatsApp] Loaded ${scheduled} reminders, ${pastDue} fired immediately`);
}

// Fetch weather from wttr.in (free, no API key)
async function fetchWeather(location) {
  if (!location) return null;
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`);
    if (!res.ok) return null;
    const data = await res.json();
    const current = data.current_condition?.[0];
    if (!current) return null;
    return { temp: current.temp_C, desc: current.weatherDesc?.[0]?.value || '', feelsLike: current.FeelsLikeC };
  } catch { return null; }
}

export function setupWhatsAppDigest() {
  // Birthday check for WhatsApp users daily at 8am
  cron.schedule('0 8 * * *', async () => {
    try {
      const { getUpcomingBirthdays } = await import('../db.js');
      const allReminders = await getAllActiveReminders();
      const waChatIds = [...new Set(allReminders.filter(r => r.chat_id.length >= 10 && /^\d+$/.test(r.chat_id)).map(r => r.chat_id))];
      const today = new Date();
      for (const chatId of waChatIds) {
        const contacts = await getUpcomingBirthdays(chatId);
        for (const c of contacts) {
          if (!c.birthday) continue;
          const [m, d] = c.birthday.split('-').map(Number);
          const bdayDate = new Date(today.getFullYear(), m - 1, d);
          if (bdayDate < today) bdayDate.setFullYear(today.getFullYear() + 1);
          const daysUntil = Math.ceil((bdayDate - today) / 86400000);
          if (daysUntil === 0) sendTextMessage(chatId, `🎂 *${c.name}'s birthday is today!*`).catch(() => {});
          else if (daysUntil === 3) sendTextMessage(chatId, `🎂 *${c.name}'s birthday is in 3 days* (${c.birthday})`).catch(() => {});
        }
      }
    } catch (err) { console.error('[WA Birthday Check]', err.message); }
  });

  // Catch missed reminders every 2 minutes — fires any past-due reminders that were never sent
  cron.schedule('*/2 * * * *', async () => {
    try {
      const { getMissedReminders } = await import('../db.js');
      const missed = await getMissedReminders();
      // Only fire WhatsApp reminders (phone number chat IDs)
      const waMissed = missed.filter(r => r.chat_id.length >= 10 && /^\d+$/.test(r.chat_id));
      for (const reminder of waMissed) {
        console.log(`[WA Missed Check] Firing missed reminder ${reminder.id}: "${reminder.text}"`);
        fireReminder(reminder);
      }
    } catch (err) {
      console.error('[WA Missed Check] Error:', err.message);
    }
  });

  cron.schedule('* * * * *', async () => {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const dateStr = now.toISOString().split('T')[0];

    const allReminders = await getAllActiveReminders();
    const waChatIds = [...new Set(
      allReminders
        .filter(r => r.chat_id.length >= 10 && /^\d+$/.test(r.chat_id))
        .map(r => r.chat_id)
    )];

    for (const chatId of waChatIds) {
      const settings = await getSettings(chatId);
      if (!settings.daily_digest || settings.digest_time !== currentTime) continue;

      const todaysReminders = await getTodaysReminders(chatId, dateStr);
      if (todaysReminders.length === 0) continue;

      let message = '*Good morning!*\n';
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
        if (r.cron_expr) {
          const streak = await getStreak(chatId, r.text);
          if (streak?.current_streak > 1) message += `\n     Streak: ${streak.current_streak} days`;
        }
      }
      // Yesterday's spending
      try {
        const { getExpenseSummary } = await import('../db.js');
        const yesterday = await getExpenseSummary(chatId, 1);
        if (yesterday.count > 0) message += `\n\nLast 24h spending: *${yesterday.total.toFixed(2)}* (${yesterday.count} transactions)`;
      } catch {}

      // Upcoming birthdays
      try {
        const { getUpcomingBirthdays } = await import('../db.js');
        const contacts = await getUpcomingBirthdays(chatId);
        const today2 = new Date();
        const upcoming = contacts.filter(c => {
          if (!c.birthday) return false;
          const [m, d] = c.birthday.split('-').map(Number);
          const bd = new Date(today2.getFullYear(), m - 1, d);
          if (bd < today2) bd.setFullYear(today2.getFullYear() + 1);
          const diff = Math.ceil((bd - today2) / 86400000);
          return diff >= 0 && diff <= 7;
        });
        if (upcoming.length > 0) {
          message += '\n\nUpcoming birthdays:';
          for (const c of upcoming) message += `\n  🎂 ${c.name} (${c.birthday})`;
        }
      } catch {}

      message += '\n\nHave a good day!';

      try {
        await sendTextMessage(chatId, message);
      } catch (err) {
        console.error(`[WhatsApp] Failed digest to ${chatId}:`, err.message);
      }
    }
  });

  // Google Calendar sync — every 15 minutes (WhatsApp users)
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { isConfigured, syncFromCalendar } = await import('../google-calendar.js');
      if (!isConfigured()) return;
      const { getUsersWithGoogleTokens } = await import('../db.js');
      const users = await getUsersWithGoogleTokens();
      for (const user of users) {
        // Only WhatsApp users (phone number chat IDs)
        if (!(user.chat_id.length >= 10 && /^\d+$/.test(user.chat_id))) continue;
        const created = await syncFromCalendar(user.chat_id, scheduleReminder);
        if (created.length > 0) {
          sendTextMessage(user.chat_id,
            `Synced ${created.length} event${created.length === 1 ? '' : 's'} from Calendar:\n${created.map(e => `- ${e}`).join('\n')}`,
          ).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[WA GCal Sync] Error:', err.message);
    }
  });

  // Idle check-in — every 12 hours (WhatsApp users)
  cron.schedule('0 */12 * * *', async () => {
    try {
      const { getLastMessageTime, getActiveReminders: getActive } = await import('../db.js');
      const allRems = await getAllActiveReminders();
      const waChatIds = [...new Set(allRems.filter(r => r.chat_id.length >= 10 && /^\d+$/.test(r.chat_id)).map(r => r.chat_id))];
      for (const chatId of waChatIds) {
        const lastMsg = await getLastMessageTime(chatId);
        if (!lastMsg) continue;
        const hoursSince = (Date.now() - new Date(lastMsg).getTime()) / 3600000;
        if (hoursSince >= 48 && hoursSince < 60) {
          const active = await getActive(chatId);
          if (active.length > 0) sendTextMessage(chatId, `Hey! You have *${active.length}* pending reminder${active.length > 1 ? 's' : ''}. Need anything?`).catch(() => {});
        }
      }
    } catch (err) { console.error('[WA Idle Check]', err.message); }
  });

  // Follow-up check — every 6 hours (WhatsApp users)
  cron.schedule('0 */6 * * *', async () => {
    try {
      const { getDueFollowups } = await import('../db.js');
      const allRems = await getAllActiveReminders();
      const waChatIds = [...new Set(allRems.filter(r => r.chat_id.length >= 10 && /^\d+$/.test(r.chat_id)).map(r => r.chat_id))];
      for (const chatId of waChatIds) {
        const due = await getDueFollowups(chatId);
        for (const f of due) {
          sendTextMessage(chatId, `*Follow-up due:* ${f.person} — ${f.subject}\nSay "followup ${f.id} done" when resolved.`).catch(() => {});
        }
      }
    } catch (err) { console.error('[WA Follow-up Check]', err.message); }
  });

  // EOD recap — 9pm Mon-Sat (WhatsApp users)
  cron.schedule('0 21 * * 1-6', async () => {
    try {
      const allRems = await getAllActiveReminders();
      const waChatIds = [...new Set(allRems.filter(r => r.chat_id.length >= 10 && /^\d+$/.test(r.chat_id)).map(r => r.chat_id))];
      for (const chatId of waChatIds) {
        const settings = await getSettings(chatId);
        if (!settings.daily_digest) continue;
        const { getExpenseSummary, getActiveReminders: getActive } = await import('../db.js');
        const active = await getActive(chatId);
        const todaySpend = await getExpenseSummary(chatId, 1);
        const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: settings.timezone });
        const tomorrowRems = await getTodaysReminders(chatId, tomorrowStr);
        let msg = '*End of Day*\n';
        if (todaySpend.count > 0) msg += `\nSpent today: *${todaySpend.total.toFixed(2)}*`;
        msg += `\nPending: *${active.length}*`;
        if (tomorrowRems.length > 0) {
          msg += `\n\n*Tomorrow (${tomorrowRems.length}):*`;
          for (const r of tomorrowRems) {
            const time = new Date(r.remind_at).toLocaleTimeString('en-US', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', hour12: true });
            msg += `\n  ${time} — ${r.text}`;
          }
        }
        msg += '\n\nGood night!';
        sendTextMessage(chatId, msg).catch(() => {});
      }
    } catch (err) { console.error('[WA EOD Recap]', err.message); }
  });

  // Week planning — Sunday 7pm (WhatsApp users)
  cron.schedule('0 19 * * 0', async () => {
    try {
      const allRems = await getAllActiveReminders();
      const waChatIds = [...new Set(allRems.filter(r => r.chat_id.length >= 10 && /^\d+$/.test(r.chat_id)).map(r => r.chat_id))];
      for (const chatId of waChatIds) {
        const settings = await getSettings(chatId);
        if (!settings.daily_digest) continue;
        const { getExpenseSummary, getPendingFollowups, getActiveReminders: getActive } = await import('../db.js');
        const active = await getActive(chatId);
        const weekSpend = await getExpenseSummary(chatId, 7);
        const followups = await getPendingFollowups(chatId);
        const days = {}; const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        for (const r of active) { const key = new Date(r.remind_at).toLocaleDateString('en-CA', { timeZone: settings.timezone }); if (!days[key]) days[key] = []; days[key].push(r); }
        let msg = '*Week Ahead*\n';
        for (const day of Object.keys(days).sort().slice(0, 7)) {
          const d = new Date(day);
          msg += `\n*${dayNames[d.getDay()]}, ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}:*`;
          for (const r of days[day]) { const time = new Date(r.remind_at).toLocaleTimeString('en-US', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', hour12: true }); msg += `\n  ${time} — ${r.text}`; }
        }
        if (weekSpend.count > 0) msg += `\n\nLast week: *${weekSpend.total.toFixed(2)}*`;
        if (followups.length > 0) msg += `\nFollow-ups: *${followups.length}*`;
        msg += '\n\nHave a great week!';
        sendTextMessage(chatId, msg).catch(() => {});
      }
    } catch (err) { console.error('[WA Week Planning]', err.message); }
  });

  // URL monitor check — every 30 minutes (WhatsApp recipients)
  cron.schedule('*/30 * * * *', async () => {
    try {
      const { checkAllMonitors } = await import('../url-monitor.js');
      const alerts = await checkAllMonitors();
      for (const alert of alerts) {
        // Only send to WhatsApp chat IDs (10+ digits)
        if (alert.monitor.chat_id.length >= 10 && /^\d+$/.test(alert.monitor.chat_id)) {
          const label = alert.monitor.label || alert.monitor.url;
          const msg = `*URL Alert: ${label}*\n${alert.details}\n${alert.monitor.url}`;
          try { await sendTextMessage(alert.monitor.chat_id, msg); } catch {}
        }
      }
    } catch (err) {
      console.error('[WhatsApp URL Monitor] Check failed:', err.message);
    }
  });
}
