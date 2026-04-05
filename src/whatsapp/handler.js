/**
 * Handles incoming WhatsApp messages — parses reminders, commands, and button replies.
 */
import { sendTextMessage, sendReminderMessage, getMediaUrl, downloadMedia, uploadMedia, sendImageMessage } from './api.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = join(__dirname, '..', '..', 'data', 'media');
mkdirSync(MEDIA_DIR, { recursive: true });
import { parseReminderSmart, parseReminder, detectCategory } from '../parser.js';
import { classifyIntent } from '../ai.js';
import {
  createReminder, getActiveReminders, getReminder, deactivateReminder,
  deactivateAllReminders, deactivateTodaysReminders, pauseAllReminders,
  resumeAllReminders, getPausedReminders, getSettings, setTimezone,
  setDailyDigest, updateReminderText, updateReminderTime,
  getTodaysReminders, getLastDeactivated, reactivateReminder,
  getWeeklyStats, attachMedia, attachMediaWithData, getLastReminder, addNoteToReminder, searchReminders,
  snoozeReminder as dbSnooze,
  incrementSnoozeCount, getSnoozeCount, resetSnoozeCount,
  clearIgnoredSince, logCompletedReminder,
} from '../db.js';
import {
  scheduleReminder, cancelReminder,
  snoozeReminder as schedSnooze,
  messageReminderMap,
} from './scheduler.js';
import { detectRecurringPattern } from '../patterns.js';
import { getConversationalResponse } from '../conversation.js';

// Track state
const pendingClearAll = new Set();
const pendingClarification = new Map();
const pendingPhotos = new Map(); // from -> { waMediaId, mimeType, caption }
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

export async function handleTextMessage(from, text, quotedMsgId = null) {
  const lower = text.trim().toLowerCase();

  // Check if this is a reply to a bot message linked to a reminder
  if (quotedMsgId) {
    const reminderId = messageReminderMap.get(quotedMsgId);
    if (reminderId) {
      const reminder = await getReminder(reminderId);
      if (reminder && reminder.active === 1) {
        // Simple keyword shortcuts
        if (/^done$/i.test(lower)) {
          cancelReminder(reminderId);
          await deactivateReminder(reminderId);
          await logCompletedReminder({ chatId: from, text: reminder.text, remindAt: reminder.remind_at });
          return sendTextMessage(from, 'Done!');
        }
        if (/^cancel$/i.test(lower)) {
          cancelReminder(reminderId);
          await deactivateReminder(reminderId);
          return sendTextMessage(from, `Cancelled "${reminder.text}"`);
        }

        // Route through AI with this specific reminder as context
        const settings = await getSettings(from);
        const aiResult = await classifyIntent(text.trim(), settings.timezone, new Date().toISOString(), [reminder]);
        if (aiResult?.intent === 'action') {
          if (aiResult.action === 'cancel') {
            cancelReminder(reminderId);
            await deactivateReminder(reminderId);
            return sendTextMessage(from, `Cancelled "${reminder.text}"`);
          }
          if (aiResult.action === 'reschedule' && aiResult.newTime) {
            cancelReminder(reminderId);
            await updateReminderTime(reminderId, new Date(aiResult.newTime).toISOString());
            scheduleReminder({ ...reminder, remind_at: new Date(aiResult.newTime).toISOString() });
            const timeStr = formatTime(new Date(aiResult.newTime).toISOString(), settings.timezone);
            return sendTextMessage(from, `Rescheduled "${reminder.text}" to ${timeStr}`);
          }
          if (aiResult.action === 'edit' && aiResult.newText) {
            await updateReminderText(reminderId, aiResult.newText);
            return sendTextMessage(from, `Updated: "${aiResult.newText}"`);
          }
          if (aiResult.action === 'add_note' && aiResult.note) {
            await addNoteToReminder(reminderId, aiResult.note);
            return sendTextMessage(from, `Note added to "${reminder.text}": ${aiResult.note}`);
          }
        }
        // Check for snooze-like patterns
        const snoozeMatch = text.match(/(\d+)\s*(min|minute|hour|hr)/i);
        if (snoozeMatch) {
          let mins = parseInt(snoozeMatch[1], 10);
          if (/hour|hr/i.test(snoozeMatch[2])) mins *= 60;
          await dbSnooze(reminderId, new Date(Date.now() + mins * 60 * 1000).toISOString());
          await schedSnooze(reminderId, mins);
          const label = mins >= 60 ? `${mins / 60} hour(s)` : `${mins} minutes`;
          return sendTextMessage(from, `Snoozed "${reminder.text}" for ${label}`);
        }
      }
    }
  }

  // Pending clear all confirmation
  if (pendingClearAll.has(from)) {
    pendingClearAll.delete(from);
    if (lower === 'yes') return doClearAll(from);
    return sendTextMessage(from, 'Clear all cancelled.');
  }

  // Pending photo awaiting a time
  if (pendingPhotos.has(from)) {
    const photo = pendingPhotos.get(from);
    pendingPhotos.delete(from);
    const settings = await getSettings(from);
    const aiResult = await classifyIntent(`remind me ${text.trim()} to ${photo.text}`, settings.timezone, new Date().toISOString(), []);
    if (aiResult?.intent === 'reminder' && aiResult.reminders?.[0]?.remindAt) {
      const r = aiResult.reminders[0];
      const id = await createReminderAndSchedule(from, {
        text: photo.text, remindAt: new Date(r.remindAt), cronExpr: null, category: null, notes: null,
      }, settings);
      await attachMediaWithData(id, 'wa_image', photo.mimeType || 'image/jpeg', photo.buffer);
      const timeStr = formatTime(new Date(r.remindAt).toISOString(), settings.timezone);
      const relTime = relativeTime(new Date(r.remindAt));
      return sendTextMessage(from, `✅ *${photo.text}*\n${timeStr} (in ${relTime})\nPhoto attached`);
    }
    return sendTextMessage(from, "Couldn't understand the time. Try: \"in 30 minutes\" or \"at 3pm\"");
  }

  // Pending AI clarification
  if (pendingClarification.has(from)) {
    const ctx = pendingClarification.get(from);
    pendingClarification.delete(from);
    const combined = `${ctx.originalText} (${text.trim()})`;
    const settings = await getSettings(from);
    const parsed = await parseReminderSmart(combined, settings.timezone);
    if (parsed && !parsed.needsInfo && parsed.remindAt) {
      return saveAndConfirm(from, parsed, settings);
    }
    return sendTextMessage(from, "Hmm, I still couldn't figure that out. Try: \"remind me at 3pm to call dentist\"");
  }

  // Menu number shortcuts (these are unambiguous)
  if (lower === '1') return sendTextMessage(from, '📝 Just type your reminder naturally!');
  if (lower === '2') return sendList(from);
  if (lower === '3') return handleClearAll(from);
  if (lower === '4') return handleTimezone(from, 'timezone');
  if (lower === '5') return handleDigest(from, 'digest');
  if (lower === '6') return sendHelp(from);

  // Explicit command prefixes
  // Only match explicit /cancel and /edit slash commands — natural language goes through AI
  if (lower.startsWith('/cancel')) return handleCancel(from, text.trim());
  if (lower.startsWith('/edit')) return handleEdit(from, text.trim());
  if (lower.startsWith('/timezone') || lower.startsWith('timezone ')) return handleTimezone(from, text.trim());
  if (lower.startsWith('/digest') || lower.startsWith('digest ')) return handleDigest(from, text.trim());

  // --- AI-first intent classification ---
  const settings = await getSettings(from);
  const activeRems = await getActiveReminders(from);
  const aiResult = await classifyIntent(text.trim(), settings.timezone, new Date().toISOString(), activeRems);

  if (aiResult) {
    if (aiResult.intent === 'chat') {
      return sendTextMessage(from, aiResult.reply || "Hey! 👋 Need to set a reminder?");
    }

    if (aiResult.intent === 'command') {
      const cmd = aiResult.command;
      if (cmd === 'menu' || cmd === 'start') return sendMenu(from);
      if (cmd === 'list') return sendList(from);
      if (cmd === 'help') return sendHelp(from);
      if (cmd === 'today') return sendTodaysList(from);
      if (cmd === 'clear_all') return handleClearAll(from);
      if (cmd === 'clear_today') return handleClearToday(from);
      if (cmd === 'pause') return handlePause(from);
      if (cmd === 'resume') return handleResume(from);
      if (cmd === 'undo') return handleUndo(from);
      if (cmd === 'summary') return handleWeekly(from);
      if (cmd === 'repeat') return handleRepeat(from);
    }

    if (aiResult.intent === 'action') {
      if (aiResult.needsInfo) {
        return sendTextMessage(from, `🤔 ${aiResult.needsInfo}`);
      }
      const ids = aiResult.ids || [];
      if (aiResult.action === 'cancel') {
        const names = [];
        for (const id of ids) {
          const r = activeRems.find(rem => rem.id === id);
          if (r) { cancelReminder(id); await deactivateReminder(id); names.push(r.text); }
        }
        if (names.length > 0) {
          return sendTextMessage(from, `✅ Cancelled: ${names.map(n => `"${n}"`).join(', ')}`);
        }
        return sendTextMessage(from, "Couldn't find those reminders.");
      }
      if (aiResult.action === 'reschedule') {
        for (const id of ids) {
          const r = activeRems.find(rem => rem.id === id);
          if (r && aiResult.newTime) {
            cancelReminder(id);
            await updateReminderTime(id, new Date(aiResult.newTime).toISOString());
            scheduleReminder({ ...r, remind_at: new Date(aiResult.newTime).toISOString() });
            const timeStr = new Date(aiResult.newTime).toLocaleString('en-US', {
              timeZone: settings.timezone, weekday: 'short', month: 'short', day: 'numeric',
              hour: '2-digit', minute: '2-digit', hour12: true,
            });
            await sendTextMessage(from, `✅ Rescheduled "${r.text}" to ${timeStr}`);
          }
        }
        return;
      }
      if (aiResult.action === 'edit') {
        for (const id of ids) {
          const r = activeRems.find(rem => rem.id === id);
          if (r && aiResult.newText) {
            await updateReminderText(id, aiResult.newText);
            await sendTextMessage(from, `✅ Updated #${id}: "${aiResult.newText}"`);
          }
        }
        return;
      }
    }

    if (aiResult.intent === 'search') {
      const results = await searchReminders(
        from, aiResult.query || null,
        aiResult.dateRange?.from || null, aiResult.dateRange?.to || null
      );
      const all = [...results.active.map(r => ({ ...r, source: 'active' })), ...results.completed.map(r => ({ ...r, source: 'completed' }))];
      if (all.length === 0) return sendTextMessage(from, 'No reminders found.');
      let msg = `Found ${all.length} reminder${all.length === 1 ? '' : 's'}:\n`;
      for (const r of all.slice(0, 15)) {
        const date = r.remind_at || r.original_remind_at || r.completed_at;
        const timeStr = date ? new Date(date).toLocaleString('en-US', {
          timeZone: settings.timezone, weekday: 'short', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit', hour12: true,
        }) : '';
        const status = r.source === 'completed' ? '✅' : (r.active === 1 ? '📌' : '⏸️');
        msg += `\n${status} *${r.text}*\n  ${timeStr}`;
      }
      return sendTextMessage(from, msg);
    }

    if (aiResult.intent === 'reminder') {
      if (aiResult.needsInfo) {
        pendingClarification.set(from, { originalText: text.trim() });
        return sendTextMessage(from, `🤔 ${aiResult.needsInfo}`);
      }
      const reminders = aiResult.reminders || [];
      for (const r of reminders) {
        if (r.remindAt) {
          const parsed = {
            text: r.text,
            remindAt: new Date(r.remindAt),
            cronExpr: r.cronExpr || null,
            category: r.category || detectCategory(r.text),
          };
          await saveAndConfirm(from, parsed, settings);
        }
      }
      if (reminders.length > 0) return;
    }
  }

  // --- Fallback: chrono-node parser (if AI unavailable) ---
  const parsed = parseReminder(text.trim(), settings.timezone);
  if (parsed) {
    return saveAndConfirm(from, parsed, settings);
  }

  // Nothing worked
  return sendTextMessage(from,
    "Hey! 😊 I'm not sure what you mean.\n\nTo set a reminder, try:\n• \"remind me at 3pm to call dentist\"\n• \"in 30 minutes check the oven\"\n\nOr just chat — I'm friendly! Send *menu* for options."
  );

}

async function handleUndo(from) {
  const last = await getLastDeactivated(from);
  if (!last) return sendTextMessage(from, 'Nothing to undo.');
  await reactivateReminder(last.id);
  scheduleReminder({ ...last, active: 1 });
  return sendTextMessage(from, `↩️ Restored: "${last.text}"`);
}

async function handleRepeat(from) {
  const last = lastCreated.get(from);
  if (!last) return sendTextMessage(from, 'Nothing to repeat. Set a reminder first!');
  const settings = await getSettings(from);
  return saveAndConfirm(from, last, settings);
}

async function handleWeekly(from) {
  const stats = await getWeeklyStats(from);
  const active = await getActiveReminders(from);
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
  const id = await createReminder({
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

  const apiResult = await sendTextMessage(from,
    `✅ Reminder set! ${catEmoji}\n\n📝 *${parsed.text}*\n⏰ ${timeStr} (in ${relTime})${recurLabel}`
  );
  // Track message ID for reply-to feature
  const wamid = apiResult?.messages?.[0]?.id;
  if (wamid) messageReminderMap.set(wamid, id);
}

/**
 * Process a button reply (snooze / done).
 */
export async function handleButtonReply(from, buttonId) {
  if (buttonId.startsWith('snooze:')) {
    const [, idStr, minsStr] = buttonId.split(':');
    const reminderId = parseInt(idStr, 10);
    const minutes = parseInt(minsStr, 10);

    await dbSnooze(reminderId, new Date(Date.now() + minutes * 60 * 1000).toISOString());
    await schedSnooze(reminderId, minutes);
    await clearIgnoredSince(reminderId);

    await incrementSnoozeCount(reminderId);
    const count = await getSnoozeCount(reminderId);

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

    const reminder = await getReminder(reminderId);
    if (reminder) {
      await logCompletedReminder({ chatId: from, text: reminder.text, remindAt: reminder.remind_at });
    }

    cancelReminder(reminderId);
    await deactivateReminder(reminderId);
    await resetSnoozeCount(reminderId);
    await clearIgnoredSince(reminderId);

    await sendTextMessage(from, '✅ Done!');

    // Check for recurring patterns
    const patterns = await detectRecurringPattern(from);
    for (const p of patterns) {
      const timeStr = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
      await sendTextMessage(from,
        `💡 I noticed you complete "*${p.text}*" every *${p.dayName}* around *${timeStr}*.\n\n` +
        `Want to make it recurring?\nSend: every ${p.dayName.toLowerCase()} at ${timeStr} ${p.text}`
      );
    }
  }

  // Smart follow-up: Reschedule to tomorrow 9am
  if (buttonId.startsWith('reschedule_tomorrow:')) {
    const reminderId = parseInt(buttonId.split(':')[1], 10);
    const reminder = await getReminder(reminderId);
    if (reminder) {
      const settings = await getSettings(from);
      const tomorrow9am = new Date();
      tomorrow9am.setDate(tomorrow9am.getDate() + 1);
      tomorrow9am.setHours(9, 0, 0, 0);

      cancelReminder(reminderId);
      await updateReminderTime(reminderId, tomorrow9am.toISOString());
      await resetSnoozeCount(reminderId);
      scheduleReminder({ ...reminder, remind_at: tomorrow9am.toISOString() });

      const timeStr = formatTime(tomorrow9am.toISOString(), settings.timezone);
      return sendTextMessage(from, `Rescheduled "${reminder.text}" to ${timeStr}`);
    }
  }

  // Smart follow-up: Drop reminder
  if (buttonId.startsWith('drop:')) {
    const reminderId = parseInt(buttonId.split(':')[1], 10);
    const reminder = await getReminder(reminderId);
    cancelReminder(reminderId);
    await deactivateReminder(reminderId);
    await resetSnoozeCount(reminderId);
    await clearIgnoredSince(reminderId);
    return sendTextMessage(from, `Dropped "${reminder?.text || 'reminder'}"`);
  }
}

// --- Feature handlers (unchanged) ---

async function sendMenu(to) {
  const reminders = await getActiveReminders(to);
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
  const reminders = await getActiveReminders(to);
  const paused = await getPausedReminders(to);
  if (reminders.length === 0 && paused.length === 0) {
    return sendTextMessage(to, 'You have no reminders.\nJust type a reminder to set one!');
  }

  const settings = await getSettings(to);
  const todayStr = new Date().toISOString().split('T')[0];
  const today = [], upcoming = [], recurring = [];

  for (const r of reminders) {
    if (r.cron_expr) recurring.push(r);
    else if (r.remind_at.startsWith(todayStr)) today.push(r);
    else upcoming.push(r);
  }

  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let idx = 0;
  let msg = '📋 *Your Reminders*\n';
  if (today.length > 0) {
    msg += '\n*Today:*\n';
    for (const r of today) {
      const time = new Date(r.remind_at).toLocaleTimeString('en-US', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', hour12: true });
      const rel = relativeTime(new Date(r.remind_at));
      const noteLabel = r.notes ? `\n    📝 ${r.notes}` : '';
      msg += `  *${letters[idx++]})* ${r.text}\n    ${time} (${rel})${noteLabel}\n`;
    }
  }
  if (upcoming.length > 0) {
    msg += '\n*Upcoming:*\n';
    for (const r of upcoming) {
      const time = formatTime(r.remind_at, settings.timezone);
      const rel = relativeTime(new Date(r.remind_at));
      const noteLabel = r.notes ? `\n    📝 ${r.notes}` : '';
      msg += `  *${letters[idx++]})* ${r.text}\n    ${time} (${rel})${noteLabel}\n`;
    }
  }
  if (recurring.length > 0) {
    msg += '\n*Recurring:*\n';
    for (const r of recurring) {
      msg += `  *${letters[idx++]})* ${r.text}\n    🔁 ${r.cron_expr}\n`;
    }
  }
  if (paused.length > 0) {
    msg += `\n*Paused (${paused.length}):*\n`;
    for (const r of paused) msg += `  ${r.text}\n`;
    msg += '\n_Send "resume" to reactivate._';
  }
  msg += '\n\n_Say "cancel a" or "cancel all" to remove._';
  return sendTextMessage(to, msg);
}

async function sendTodaysList(from) {
  const settings = await getSettings(from);
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: settings.timezone }); // YYYY-MM-DD
  const todays = await getTodaysReminders(from, dateStr);

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
  const settings = await getSettings(from);
  const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: settings.timezone });
  const todays = await getTodaysReminders(from, dateStr);

  if (todays.length === 0) return sendTextMessage(from, 'No reminders for today to clear.');

  for (const r of todays) cancelReminder(r.id);
  const count = await deactivateTodaysReminders(from, dateStr);
  return sendTextMessage(from, `✅ Cleared ${count} reminder${count === 1 ? '' : 's'} for today.`);
}

async function handleClearAll(from) {
  const reminders = await getActiveReminders(from);
  if (reminders.length === 0) return sendTextMessage(from, 'You have no active reminders to clear.');
  pendingClearAll.add(from);
  return sendTextMessage(from, `⚠️ Are you sure you want to clear all *${reminders.length}* reminder${reminders.length === 1 ? '' : 's'}?\n\nReply *YES* to confirm.`);
}

async function doClearAll(from) {
  const reminders = await getActiveReminders(from);
  for (const r of reminders) cancelReminder(r.id);
  const count = await deactivateAllReminders(from);
  return sendTextMessage(from, `✅ Cleared ${count} reminder${count === 1 ? '' : 's'}.`);
}

async function handleCancel(to, text) {
  const match = text.match(/cancel\s+(\d+)/i);
  if (!match) return sendTextMessage(to, 'Usage: *cancel 3*\nSend *view* to see reminder IDs.');
  const id = parseInt(match[1], 10);
  const reminders = await getActiveReminders(to);
  const reminder = reminders.find(r => r.id === id);
  if (!reminder) return sendTextMessage(to, `Reminder #${id} not found.`);
  cancelReminder(id);
  await deactivateReminder(id);
  return sendTextMessage(to, `✅ Cancelled: "${reminder.text}"`);
}

async function handleEdit(to, text) {
  const match = text.match(/edit\s+(\d+)\s+(.+)/i);
  if (!match) return sendTextMessage(to, 'Usage:\n• *edit 3 to 5pm* — change time\n• *edit 3 buy groceries* — change text');
  const id = parseInt(match[1], 10);
  const change = match[2].trim();
  const reminders = await getActiveReminders(to);
  const reminder = reminders.find(r => r.id === id);
  if (!reminder) return sendTextMessage(to, `Reminder #${id} not found.`);
  const settings = await getSettings(to);
  if (change.match(/^to\s+/i)) {
    const timeText = change.replace(/^to\s+/i, '');
    const parsed = parseReminder(`remind me at ${timeText} to placeholder`, settings.timezone);
    if (!parsed) return sendTextMessage(to, `Couldn't understand "${timeText}" as a time.`);
    cancelReminder(id);
    await updateReminderTime(id, parsed.remindAt.toISOString());
    scheduleReminder({ ...reminder, remind_at: parsed.remindAt.toISOString() });
    return sendTextMessage(to, `✅ Reminder #${id} updated to *${formatTime(parsed.remindAt.toISOString(), settings.timezone)}*`);
  }
  await updateReminderText(id, change);
  return sendTextMessage(to, `✅ Reminder #${id} updated: "${change}"`);
}

async function handlePause(from) {
  const reminders = await getActiveReminders(from);
  if (reminders.length === 0) return sendTextMessage(from, 'No active reminders to pause.');
  for (const r of reminders) cancelReminder(r.id);
  const count = await pauseAllReminders(from);
  return sendTextMessage(from, `⏸️ Paused ${count} reminder${count === 1 ? '' : 's'}.\nSend *resume* to reactivate.`);
}

async function handleResume(from) {
  const paused = await getPausedReminders(from);
  if (paused.length === 0) return sendTextMessage(from, 'No paused reminders to resume.');
  const count = await resumeAllReminders(from);
  const active = await getActiveReminders(from);
  for (const r of active) scheduleReminder(r);
  return sendTextMessage(from, `▶️ Resumed ${count} reminder${count === 1 ? '' : 's'}.`);
}

async function handleTimezone(to, text) {
  const match = text.match(/timezone\s+(.+)/i);
  if (!match) {
    const settings = await getSettings(to);
    return sendTextMessage(to, `Your timezone: *${settings.timezone}*\n\nTo change: *timezone Asia/Dubai*`);
  }
  const tz = match[1].trim();
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); } catch {
    return sendTextMessage(to, `"${tz}" is not valid.\nExamples: America/New_York, Europe/London, Asia/Dubai`);
  }
  await setTimezone(to, tz);
  return sendTextMessage(to, `✅ Timezone set to *${tz}*`);
}

async function handleDigest(to, text) {
  const match = text.match(/digest\s+(on|off)(?:\s+(\d{2}:\d{2}))?/i);
  if (!match) {
    const settings = await getSettings(to);
    const status = settings.daily_digest ? `ON at ${settings.digest_time}` : 'OFF';
    return sendTextMessage(to, `Daily digest: *${status}*\n\nUsage: *digest on* [HH:MM] | *digest off*`);
  }
  if (match[1].toLowerCase() === 'off') { await setDailyDigest(to, false); return sendTextMessage(to, '✅ Daily digest turned off.'); }
  const time = match[2] || '08:00';
  await setDailyDigest(to, true, time);
  return sendTextMessage(to, `✅ Daily digest enabled at *${time}*`);
}

// --- Image handler ---

export async function handleImageMessage(from, waMediaId, caption, mimeType) {
  try {
    const settings = await getSettings(from);

    // Download image immediately and store binary for later
    let imageBuffer = null;
    const mediaUrl = await getMediaUrl(waMediaId);
    if (mediaUrl) {
      imageBuffer = await downloadMedia(mediaUrl);
    }

    if (caption) {
      const activeRems = await getActiveReminders(from);
      const aiResult = await classifyIntent(caption, settings.timezone, new Date().toISOString(), activeRems);

      if (aiResult?.intent === 'reminder' && aiResult.reminders?.[0]?.remindAt) {
        const r = aiResult.reminders[0];
        const id = await createReminderAndSchedule(from, {
          text: r.text, remindAt: new Date(r.remindAt), cronExpr: r.cronExpr || null,
          category: r.category || null, notes: r.notes || null,
        }, settings);
        await attachMediaWithData(id, 'wa_image', mimeType, imageBuffer);
        const timeStr = formatTime(new Date(r.remindAt).toISOString(), settings.timezone);
        const relTime = relativeTime(new Date(r.remindAt));
        const res = await sendTextMessage(from, `✅ *${r.text}*\n${timeStr} (in ${relTime})\nPhoto attached`);
        const wamid = res?.messages?.[0]?.id;
        if (wamid) messageReminderMap.set(wamid, id);
        return res;
      }

      const parsed = parseReminder(caption, settings.timezone);
      if (parsed) {
        const id = await createReminderAndSchedule(from, parsed, settings);
        await attachMediaWithData(id, 'wa_image', mimeType, imageBuffer);
        const timeStr = formatTime(parsed.remindAt.toISOString(), settings.timezone);
        const relTime = relativeTime(parsed.remindAt);
        return sendTextMessage(from, `✅ *${parsed.text}*\n${timeStr} (in ${relTime})\nPhoto attached`);
      }

      // Store in pending with buffer
      pendingPhotos.set(from, { buffer: imageBuffer, mimeType, text: caption });
      return sendTextMessage(from, 'Got the photo! When should I remind you?');
    }

    // No caption — ask
    pendingPhotos.set(from, { buffer: imageBuffer, mimeType, text: 'Photo reminder' });
    return sendTextMessage(from, 'Got the photo! When should I remind you about it?');
  } catch (err) {
    console.error('[WA Image error]', err);
    return sendTextMessage(from, 'Got the photo! When should I remind you about it?');
  }
}

// Helper to create + schedule a reminder and return the ID
async function createReminderAndSchedule(from, parsed, settings) {
  const id = await createReminder({
    chatId: from, text: parsed.text, remindAt: parsed.remindAt.toISOString(),
    cronExpr: parsed.cronExpr, timezone: settings.timezone, category: parsed.category,
  });
  if (parsed.notes) await addNoteToReminder(id, parsed.notes);
  const reminder = await getReminder(id);
  scheduleReminder(reminder);
  return id;
}
