import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import {
  createReminder, getSettings, getReminder, getActiveReminders,
  snoozeReminder as dbSnooze, deactivateReminder, addNoteToReminder,
  attachMedia, getLastReminder, searchReminders,
  incrementSnoozeCount, getSnoozeCount, resetSnoozeCount,
  clearIgnoredSince, logCompletedReminder, resetFireCount,
  updateStreak, getAllStreaks,
} from './db.js';
import { parseReminderSmart, parseReminder, detectCategory } from './parser.js';
import { classifyIntent } from './ai.js';
import { detectRecurringPattern } from './patterns.js';
import {
  init as initScheduler,
  scheduleReminder,
  loadAllReminders,
  setupDailyDigest,
  snoozeReminder as schedSnooze,
  cancelReminder,
  messageReminderMap,
} from './scheduler.js';
import {
  handleMenu, handleHelp, handleSet, handleList, handleToday,
  handleClearToday, handleCancel, handleEdit, handleClearAll,
  handleClearAllConfirm, handlePause, handleResume, handleTimezone,
  handleDigest, handleUndo, handleWeeklySummary,
  trackLastCreated, getLastCreated,
  pendingClearAll, relativeTime, formatTime,
} from './commands.js';
import { getConversationalResponse } from './conversation.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env file');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
initScheduler(bot);

await loadAllReminders();
setupDailyDigest();

console.log('🤖 Telegram Reminder bot is running...');

// Track AI clarification follow-ups
const pendingClarification = new Map(); // chatId -> { originalText }

// --- Command handlers ---

bot.onText(/\/start/, (msg) => handleMenu(bot, msg));
bot.onText(/\/menu/, (msg) => handleMenu(bot, msg));
bot.onText(/\/help/, (msg) => handleHelp(bot, msg));
bot.onText(/\/set/, (msg) => handleSet(bot, msg));
bot.onText(/\/list/, (msg) => handleList(bot, msg));
bot.onText(/\/today/, (msg) => handleToday(bot, msg));
bot.onText(/\/cleartoday/, (msg) => handleClearToday(bot, msg));
bot.onText(/\/cancel\s*(.*)/, (msg, match) => handleCancel(bot, msg, match));
bot.onText(/\/edit\s*(.*)/, (msg, match) => handleEdit(bot, msg, match));
bot.onText(/\/clearall/, (msg) => handleClearAll(bot, msg));
bot.onText(/\/undo/, (msg) => handleUndo(bot, msg));
bot.onText(/\/summary/, (msg) => handleWeeklySummary(bot, msg));
bot.onText(/\/pause/, (msg) => handlePause(bot, msg));
bot.onText(/\/resume/, (msg) => handleResume(bot, msg));
bot.onText(/\/timezone\s*(.*)/, (msg, match) => handleTimezone(bot, msg, match));
bot.onText(/\/digest\s*(.*)/, (msg, match) => handleDigest(bot, msg, match));

// --- Callback queries (snooze/done buttons) ---

bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;

  if (data.startsWith('snooze:')) {
    const [, idStr, minsStr] = data.split(':');
    const reminderId = parseInt(idStr, 10);
    const minutes = parseInt(minsStr, 10);

    await dbSnooze(reminderId, new Date(Date.now() + minutes * 60 * 1000).toISOString());
    await schedSnooze(reminderId, minutes);
    await clearIgnoredSince(reminderId);

    // Smart rescheduling — track snooze count
    await incrementSnoozeCount(reminderId);
    const count = await getSnoozeCount(reminderId);

    const label = minutes >= 60 ? `${minutes / 60} hour(s)` : `${minutes} minutes`;
    await bot.answerCallbackQuery(query.id, { text: `Snoozed for ${label}` });

    if (count >= 3) {
      await bot.editMessageText(
        `⏰ _Snoozed for ${label}_\n\n💡 You've snoozed this *${count} times*. Want to reschedule to tomorrow morning?\nSend /edit ${reminderId} to tomorrow 9am`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
      );
    } else {
      await bot.editMessageText(
        `⏰ _Snoozed for ${label}_`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
      );
    }
  }

  if (data.startsWith('done:')) {
    const reminderId = parseInt(data.split(':')[1], 10);

    // Log completion before deactivating
    const reminder = await getReminder(reminderId);
    if (reminder) {
      await logCompletedReminder({
        chatId: String(chatId),
        text: reminder.text,
        remindAt: reminder.remind_at,
      });
    }

    cancelReminder(reminderId);
    await deactivateReminder(reminderId);
    await resetSnoozeCount(reminderId);
    await resetFireCount(reminderId);
    await clearIgnoredSince(reminderId);

    // Track streak for recurring reminders
    let streakMsg = '';
    if (reminder?.cron_expr) {
      const streak = await updateStreak(String(chatId), reminder.text, reminder.cron_expr);
      if (streak > 1) streakMsg = `\n${streak}-day streak!`;
    }

    await bot.answerCallbackQuery(query.id, { text: 'Marked as done!' });
    await bot.editMessageText(
      `✅ _Done!_${streakMsg}`,
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
    );

    // Check for recurring patterns
    const patterns = await detectRecurringPattern(String(chatId));
    for (const p of patterns) {
      const timeStr = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
      bot.sendMessage(chatId,
        `💡 I noticed you complete "*${p.text}*" every *${p.dayName}* around *${timeStr}*.\n\n` +
        `Want to make it a recurring reminder?\n` +
        `Send: every ${p.dayName.toLowerCase()} at ${timeStr} ${p.text}`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  // Smart follow-up: Reschedule to tomorrow 9am
  if (data.startsWith('reschedule_tomorrow:')) {
    const reminderId = parseInt(data.split(':')[1], 10);
    const reminder = await getReminder(reminderId);
    if (reminder) {
      const settings = await getSettings(String(chatId));
      const tomorrow9am = new Date();
      tomorrow9am.setDate(tomorrow9am.getDate() + 1);
      tomorrow9am.setHours(9, 0, 0, 0);

      cancelReminder(reminderId);
      const { updateReminderTime: updateTime } = await import('./db.js');
      await updateTime(reminderId, tomorrow9am.toISOString());
      await resetSnoozeCount(reminderId);
      scheduleReminder({ ...reminder, remind_at: tomorrow9am.toISOString() });

      const timeStr = tomorrow9am.toLocaleString('en-US', {
        timeZone: settings.timezone, weekday: 'short', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true,
      });
      await bot.answerCallbackQuery(query.id, { text: 'Rescheduled!' });
      await bot.editMessageText(
        `Rescheduled "${reminder.text}" to ${timeStr}`,
        { chat_id: chatId, message_id: query.message.message_id }
      );
    }
  }

  // Smart follow-up: Drop reminder
  if (data.startsWith('drop:')) {
    const reminderId = parseInt(data.split(':')[1], 10);
    const reminder = await getReminder(reminderId);
    cancelReminder(reminderId);
    await deactivateReminder(reminderId);
    await resetSnoozeCount(reminderId);
    await clearIgnoredSince(reminderId);

    await bot.answerCallbackQuery(query.id, { text: 'Dropped!' });
    await bot.editMessageText(
      `Dropped "${reminder?.text || 'reminder'}"`,
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }
});

// --- Photo handler ---

// Store pending photos waiting for a time
const pendingPhotos = new Map();

// --- Natural language message handler ---

bot.on('message', async (msg) => {
  // Handle photos completely — don't fall through to text handler
  if (msg.photo && msg.photo.length > 0) {
    const chatId = msg.chat.id;
    const msgId = msg.message_id;
    const caption = msg.caption || '';

    try {
      if (caption) {
        // Photo with caption — try to create a reminder
        const settings = await getSettings(String(chatId));
        const activeRems = await getActiveReminders(String(chatId));
        const aiResult = await classifyIntent(caption, settings.timezone, new Date().toISOString(), activeRems);

        if (aiResult?.intent === 'reminder' && aiResult.reminders?.[0]?.remindAt) {
          const r = aiResult.reminders[0];
          await saveAndConfirm(chatId, {
            text: r.text, remindAt: new Date(r.remindAt), cronExpr: r.cronExpr || null,
            category: r.category || null, notes: r.notes || null,
            mediaType: 'reply', mediaId: String(msgId),
          }, settings);
          return;
        }

        // AI couldn't parse or needs info — try chrono
        const parsed = parseReminder(caption, settings.timezone);
        if (parsed) {
          parsed.mediaType = 'reply';
          parsed.mediaId = String(msgId);
          await saveAndConfirm(chatId, parsed, settings);
          return;
        }

        // Nothing worked — store photo and ask for time
        pendingPhotos.set(String(chatId), { msgId, text: caption });
        bot.sendMessage(chatId, 'Got the photo! When should I remind you?');
      } else {
        // No caption — always ask when to remind
        pendingPhotos.set(String(chatId), { msgId, text: 'Photo reminder' });
        bot.sendMessage(chatId, 'Got the photo! When should I remind you about it?');
      }
    } catch (err) {
      console.error('[Photo error]', err);
      pendingPhotos.set(String(chatId), { msgId, text: caption || 'Photo reminder' });
      bot.sendMessage(chatId, 'Got the photo! When should I remind you about it?').catch(() => {});
    }
    return;
  }

  if (!msg.text || msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const lower = text.toLowerCase();

  // Check if this is a reply to a bot message linked to a reminder
  if (msg.reply_to_message) {
    const repliedMsgId = msg.reply_to_message.message_id;
    const reminderId = messageReminderMap.get(repliedMsgId);
    if (reminderId) {
      const reminder = await getReminder(reminderId);
      if (reminder && reminder.active === 1) {
        const settings = await getSettings(String(chatId));
        const aiResult = await classifyIntent(text, settings.timezone, new Date().toISOString(), [reminder]);
        if (aiResult) {
          if (aiResult.intent === 'action') {
            const ids = aiResult.ids || [reminderId];
            if (aiResult.action === 'cancel') {
              cancelReminder(reminderId);
              await deactivateReminder(reminderId);
              bot.sendMessage(chatId, `Cancelled "${reminder.text}"`);
              return;
            }
            if (aiResult.action === 'reschedule' && aiResult.newTime) {
              cancelReminder(reminderId);
              const { updateReminderTime: updateTime } = await import('./db.js');
              await updateTime(reminderId, new Date(aiResult.newTime).toISOString());
              const { scheduleReminder: sched } = await import('./scheduler.js');
              sched({ ...reminder, remind_at: new Date(aiResult.newTime).toISOString() });
              const timeStr = new Date(aiResult.newTime).toLocaleString('en-US', {
                timeZone: settings.timezone, weekday: 'short', month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: true,
              });
              bot.sendMessage(chatId, `Rescheduled "${reminder.text}" to ${timeStr}`);
              return;
            }
            if (aiResult.action === 'edit' && aiResult.newText) {
              const { updateReminderText: updateText } = await import('./db.js');
              await updateText(reminderId, aiResult.newText);
              bot.sendMessage(chatId, `Updated: "${aiResult.newText}"`);
              return;
            }
            if (aiResult.action === 'add_note' && aiResult.note) {
              await addNoteToReminder(reminderId, aiResult.note);
              bot.sendMessage(chatId, `Note added to "${reminder.text}": ${aiResult.note}`);
              return;
            }
          }
          // Handle snooze keywords directly
          if (aiResult.intent === 'chat' || aiResult.intent === 'reminder') {
            // Check for simple snooze-like patterns
            const snoozeMatch = text.match(/(\d+)\s*(min|minute|hour|hr)/i);
            if (snoozeMatch) {
              let mins = parseInt(snoozeMatch[1], 10);
              if (/hour|hr/i.test(snoozeMatch[2])) mins *= 60;
              await dbSnooze(reminderId, new Date(Date.now() + mins * 60 * 1000).toISOString());
              await schedSnooze(reminderId, mins);
              const label = mins >= 60 ? `${mins / 60} hour(s)` : `${mins} minutes`;
              bot.sendMessage(chatId, `Snoozed "${reminder.text}" for ${label}`);
              return;
            }
          }
        }
        // Fallback for simple replies like "done", "cancel", "snooze"
        if (/^done$/i.test(lower)) {
          cancelReminder(reminderId);
          await deactivateReminder(reminderId);
          await logCompletedReminder({ chatId: String(chatId), text: reminder.text, remindAt: reminder.remind_at });
          bot.sendMessage(chatId, 'Done!');
          return;
        }
        if (/^cancel$/i.test(lower)) {
          cancelReminder(reminderId);
          await deactivateReminder(reminderId);
          bot.sendMessage(chatId, `Cancelled "${reminder.text}"`);
          return;
        }
      }
    }
  }

  // Check for pending photo awaiting a time
  if (pendingPhotos.has(String(chatId))) {
    const photo = pendingPhotos.get(String(chatId));
    pendingPhotos.delete(String(chatId));
    const settings = await getSettings(String(chatId));
    const aiResult = await classifyIntent(`remind me ${text} to ${photo.text}`, settings.timezone, new Date().toISOString(), []);
    if (aiResult?.intent === 'reminder' && aiResult.reminders?.[0]?.remindAt) {
      const r = aiResult.reminders[0];
      await saveAndConfirm(chatId, {
        text: photo.text,
        remindAt: new Date(r.remindAt),
        cronExpr: null,
        category: r.category || null,
        notes: null,
        mediaType: 'reply',
        mediaId: String(photo.msgId),
      }, settings);
    } else {
      bot.sendMessage(chatId, "Couldn't understand the time. Try: \"in 30 minutes\" or \"at 3pm\"");
      pendingPhotos.set(String(chatId), photo);
    }
    return;
  }

  // Check for pending "YES" confirmation for clear all
  if (pendingClearAll.has(String(chatId))) {
    pendingClearAll.delete(String(chatId));
    if (lower === 'yes') {
      await handleClearAllConfirm(bot, msg);
      return;
    }
    bot.sendMessage(chatId, 'Clear all cancelled.');
    return;
  }

  // Check for pending AI clarification
  if (pendingClarification.has(String(chatId))) {
    const ctx = pendingClarification.get(String(chatId));
    pendingClarification.delete(String(chatId));
    const combined = `${ctx.originalText} (${text})`;
    const settings = await getSettings(String(chatId));
    const parsed = await parseReminderSmart(combined, settings.timezone);
    if (parsed && !parsed.needsInfo && parsed.remindAt) {
      return await saveAndConfirm(chatId, parsed, settings);
    }
    bot.sendMessage(chatId, "Hmm, I still couldn't figure that out. Try: \"remind me at 3pm to call dentist\"");
    return;
  }

  // --- AI-first intent classification ---
  const settings = await getSettings(String(chatId));
  const activeReminders = await getActiveReminders(String(chatId));
  const aiResult = await classifyIntent(text, settings.timezone, new Date().toISOString(), activeReminders);

  if (aiResult) {
    if (aiResult.intent === 'chat') {
      bot.sendMessage(chatId, aiResult.reply || "Hey! 👋 Need to set a reminder?");
      return;
    }

    if (aiResult.intent === 'command') {
      const cmd = aiResult.command;
      if (cmd === 'menu' || cmd === 'start') { await handleMenu(bot, msg); return; }
      if (cmd === 'list') { await handleList(bot, msg); return; }
      if (cmd === 'help') { handleHelp(bot, msg); return; }
      if (cmd === 'today') { await handleToday(bot, msg); return; }
      if (cmd === 'clear_all') { await handleClearAll(bot, msg); return; }
      if (cmd === 'clear_today') { await handleClearToday(bot, msg); return; }
      if (cmd === 'pause') { await handlePause(bot, msg); return; }
      if (cmd === 'resume') { await handleResume(bot, msg); return; }
      if (cmd === 'undo') { await handleUndo(bot, msg); return; }
      if (cmd === 'summary') { await handleWeeklySummary(bot, msg); return; }
      if (cmd === 'streaks') {
        const streaks = await getAllStreaks(String(chatId));
        if (streaks.length === 0) { bot.sendMessage(chatId, 'No active streaks yet. Complete recurring reminders to build streaks!'); return; }
        let msg2 = '*Your Streaks*\n';
        for (const s of streaks) {
          msg2 += `\n*${s.reminder_text}*\nCurrent: ${s.current_streak} days | Best: ${s.longest_streak} days`;
        }
        bot.sendMessage(chatId, msg2, { parse_mode: 'Markdown' });
        return;
      }
      if (cmd === 'repeat') {
        const last = getLastCreated(String(chatId));
        if (!last) { bot.sendMessage(chatId, 'Nothing to repeat.'); return; }
        await saveAndConfirm(chatId, last, settings);
        return;
      }
      if (cmd === 'timezone' && aiResult.args) { await handleTimezone(bot, msg, [null, aiResult.args]); return; }
      if (cmd === 'digest' && aiResult.args) { await handleDigest(bot, msg, [null, aiResult.args]); return; }
    }

    if (aiResult.intent === 'action') {
      if (aiResult.needsInfo) {
        bot.sendMessage(chatId, `🤔 ${aiResult.needsInfo}`);
        return;
      }
      const ids = aiResult.ids || [];
      if (aiResult.action === 'cancel') {
        const names = [];
        for (const id of ids) {
          const r = activeReminders.find(rem => rem.id === id);
          if (r) { cancelReminder(id); await deactivateReminder(id); names.push(r.text); }
        }
        if (names.length > 0) {
          bot.sendMessage(chatId, `✅ Cancelled: ${names.map(n => `"${n}"`).join(', ')}`);
        } else {
          bot.sendMessage(chatId, "Couldn't find those reminders.");
        }
        return;
      }
      if (aiResult.action === 'reschedule') {
        for (const id of ids) {
          const r = activeReminders.find(rem => rem.id === id);
          if (r && aiResult.newTime) {
            cancelReminder(id);
            const { updateReminderTime: updateTime } = await import('./db.js');
            await updateTime(id, new Date(aiResult.newTime).toISOString());
            const { scheduleReminder: sched } = await import('./scheduler.js');
            sched({ ...r, remind_at: new Date(aiResult.newTime).toISOString() });
            const timeStr = new Date(aiResult.newTime).toLocaleString('en-US', {
              timeZone: settings.timezone, weekday: 'short', month: 'short', day: 'numeric',
              hour: '2-digit', minute: '2-digit', hour12: true,
            });
            bot.sendMessage(chatId, `✅ Rescheduled "${r.text}" to ${timeStr}`);
          }
        }
        return;
      }
      if (aiResult.action === 'edit') {
        for (const id of ids) {
          const r = activeReminders.find(rem => rem.id === id);
          if (r && aiResult.newText) {
            const { updateReminderText: updateText } = await import('./db.js');
            await updateText(id, aiResult.newText);
            bot.sendMessage(chatId, `✅ Updated #${id}: "${aiResult.newText}"`);
          }
        }
        return;
      }
      if (aiResult.action === 'add_note') {
        for (const id of ids) {
          const r = activeReminders.find(rem => rem.id === id);
          if (r && aiResult.note) {
            await addNoteToReminder(id, aiResult.note);
            bot.sendMessage(chatId, `📝 Note added to "${r.text}": ${aiResult.note}`);
          }
        }
        return;
      }
    }

    if (aiResult.intent === 'search') {
      const results = await searchReminders(
        String(chatId), aiResult.query || null,
        aiResult.dateRange?.from || null, aiResult.dateRange?.to || null
      );
      const all = [...results.active.map(r => ({ ...r, source: 'active' })), ...results.completed.map(r => ({ ...r, source: 'completed' }))];
      if (all.length === 0) {
        bot.sendMessage(chatId, 'No reminders found.');
        return;
      }
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
      bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      return;
    }

    if (aiResult.intent === 'reminder') {
      if (aiResult.needsInfo) {
        pendingClarification.set(String(chatId), { originalText: text });
        bot.sendMessage(chatId, `🤔 ${aiResult.needsInfo}`);
        return;
      }
      const reminders = aiResult.reminders || [];
      // Extract URL from original message
      const urlMatch = text.match(/(https?:\/\/[^\s]+)/i);
      for (const r of reminders) {
        if (r.remindAt) {
          const parsed = {
            text: r.text,
            remindAt: new Date(r.remindAt),
            cronExpr: r.cronExpr || null,
            category: r.category || detectCategory(r.text),
            notes: r.notes || null,
            priority: r.priority || 'normal',
            mediaType: urlMatch ? 'link' : null,
            mediaId: urlMatch ? urlMatch[1] : null,
          };
          await saveAndConfirm(chatId, parsed, settings);
        }
      }
      if (reminders.length > 0) return;
    }
  }

  // --- Fallback: try chrono-node parser (if AI unavailable or returned nothing useful) ---
  const parsed = parseReminder(text, settings.timezone);

  if (parsed) {
    await saveAndConfirm(chatId, parsed, settings);
    return;
  }

  // Nothing worked — friendly fallback
  bot.sendMessage(chatId,
    "Hey! 😊 I'm not sure what you mean.\n\n" +
    "To set a reminder, try:\n" +
    '• "remind me at 3pm to call dentist"\n' +
    '• "in 30 minutes check the oven"\n\n' +
    "Or just chat — I'm friendly! Send /menu for options."
  );
});

async function saveAndConfirm(chatId, parsed, settings) {
  trackLastCreated(chatId, parsed);

  const id = await createReminder({
    chatId: String(chatId),
    text: parsed.text,
    remindAt: parsed.remindAt.toISOString(),
    cronExpr: parsed.cronExpr,
    timezone: settings.timezone,
    category: parsed.category,
    priority: parsed.priority,
  });

  // Save notes if present
  if (parsed.notes) {
    await addNoteToReminder(id, parsed.notes);
  }

  // Check for pending photo to attach
  const pendingPhoto = pendingPhotos.get(String(chatId));
  if (pendingPhoto) {
    pendingPhotos.delete(String(chatId));
    await attachMedia(id, 'reply', String(pendingPhoto.msgId));
  }

  // Save explicitly provided media
  if (parsed.mediaType && parsed.mediaId) {
    await attachMedia(id, parsed.mediaType, parsed.mediaId);
  }

  // Re-fetch from DB so media_type, media_id, notes are all included
  const reminder = await getReminder(id);
  scheduleReminder(reminder);

  const timeStr = formatTime(parsed.remindAt.toISOString(), settings.timezone);
  const relTime = relativeTime(parsed.remindAt);
  const recurLabel = parsed.cronExpr ? '\nRecurring' : '';
  const noteLabel = parsed.notes ? `\nNote: ${parsed.notes}` : '';
  const priorityLabel = parsed.priority === 'urgent' ? '\nURGENT' : parsed.priority === 'low' ? '\nLow priority' : '';
  const hasPhoto = parsed.mediaType === 'reply' || pendingPhotos.has(String(chatId));
  const mediaLabel = hasPhoto ? '\nPhoto linked' : parsed.mediaType === 'link' ? `\n${parsed.mediaId}` : '';

  const sentMsg = await bot.sendMessage(
    chatId,
    `✅ *${parsed.text}*\n${timeStr} (in ${relTime})${recurLabel}${priorityLabel}${noteLabel}${mediaLabel}`,
    { parse_mode: 'Markdown' }
  );
  if (sentMsg) messageReminderMap.set(sentMsg.message_id, id);
}
