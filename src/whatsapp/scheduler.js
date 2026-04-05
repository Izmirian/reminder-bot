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
    const contextMsg = buildContextualMessage(reminder.text, reminder.category, settings.timezone, reminder.notes);

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
    const timeout = setTimeout(() => fireReminder(reminder), delay);
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

export function setupWhatsAppDigest() {
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

      let message = '📋 *Today\'s Reminders:*\n\n';
      todaysReminders.forEach((r, i) => {
        const time = new Date(r.remind_at).toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', hour12: true,
        });
        message += `${i + 1}. ${time} — ${r.text}\n`;
      });

      try {
        await sendTextMessage(chatId, message);
      } catch (err) {
        console.error(`[WhatsApp] Failed digest to ${chatId}:`, err.message);
      }
    }
  });
}
