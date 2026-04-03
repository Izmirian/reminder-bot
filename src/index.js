import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import {
  createReminder, getSettings, getReminder, getActiveReminders,
  snoozeReminder as dbSnooze, deactivateReminder, addNoteToReminder,
  attachMedia, getLastReminder,
  incrementSnoozeCount, getSnoozeCount, resetSnoozeCount,
  clearIgnoredSince, logCompletedReminder,
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

loadAllReminders();
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

    dbSnooze(reminderId, new Date(Date.now() + minutes * 60 * 1000).toISOString());
    schedSnooze(reminderId, minutes);
    clearIgnoredSince(reminderId);

    // Smart rescheduling — track snooze count
    incrementSnoozeCount(reminderId);
    const count = getSnoozeCount(reminderId);

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
    const reminder = getReminder(reminderId);
    if (reminder) {
      logCompletedReminder({
        chatId: String(chatId),
        text: reminder.text,
        remindAt: reminder.remind_at,
      });
    }

    cancelReminder(reminderId);
    deactivateReminder(reminderId);
    resetSnoozeCount(reminderId);
    clearIgnoredSince(reminderId);

    await bot.answerCallbackQuery(query.id, { text: 'Marked as done!' });
    await bot.editMessageText(
      '✅ _Done!_',
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
    );

    // Check for recurring patterns
    const patterns = detectRecurringPattern(String(chatId));
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
});

// --- Photo handler ---

// Store pending photos waiting for a time
const pendingPhotos = new Map();

// --- Natural language message handler ---

bot.on('message', async (msg) => {
  // Handle photos inside message event (more reliable than bot.on('photo'))
  if (msg.photo && msg.photo.length > 0) {
    const chatId = msg.chat.id;
    const caption = msg.caption || '';
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const settings = getSettings(String(chatId));

    if (caption) {
      const aiResult = await classifyIntent(caption, settings.timezone, new Date().toISOString(), getActiveReminders(String(chatId)));

      if (aiResult?.intent === 'reminder' && aiResult.reminders?.[0]?.remindAt) {
        const r = aiResult.reminders[0];
        saveAndConfirm(chatId, {
          text: r.text, remindAt: new Date(r.remindAt), cronExpr: r.cronExpr || null,
          category: r.category || detectCategory(r.text), notes: r.notes || null,
          mediaType: 'photo', mediaId: fileId,
        }, settings);
        return;
      }

      if (aiResult?.intent === 'reminder' && (aiResult.needsInfo || aiResult.reminders?.[0])) {
        pendingPhotos.set(String(chatId), { fileId, text: aiResult.reminders?.[0]?.text || caption });
        bot.sendMessage(chatId, 'Got the photo! When should I remind you?');
        return;
      }

      if (aiResult?.intent === 'action' && aiResult.action === 'add_note') {
        for (const id of (aiResult.ids || [])) {
          attachMedia(id, 'photo', fileId);
          const rem = getActiveReminders(String(chatId)).find(r => r.id === id);
          if (rem) bot.sendMessage(chatId, `Photo attached to "${rem.text}"`);
        }
        return;
      }
    }

    // No caption or no time — attach to last or ask
    const lastRem = getLastReminder(String(chatId));
    if (lastRem) {
      attachMedia(lastRem.id, 'photo', fileId);
      bot.sendMessage(chatId, `Photo attached to "${lastRem.text}"`);
    } else {
      pendingPhotos.set(String(chatId), { fileId, text: caption || 'Photo reminder' });
      bot.sendMessage(chatId, 'Got the photo! When should I remind you about it?');
    }
    return;
  }

  if (!msg.text || msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const lower = text.toLowerCase();

  // Check for pending photo awaiting a time
  if (pendingPhotos.has(String(chatId))) {
    const photo = pendingPhotos.get(String(chatId));
    pendingPhotos.delete(String(chatId));
    const settings = getSettings(String(chatId));
    const aiResult = await classifyIntent(`remind me ${text} to ${photo.text}`, settings.timezone, new Date().toISOString(), []);
    if (aiResult?.intent === 'reminder' && aiResult.reminders?.[0]?.remindAt) {
      const r = aiResult.reminders[0];
      saveAndConfirm(chatId, {
        text: photo.text,
        remindAt: new Date(r.remindAt),
        cronExpr: null,
        category: r.category || null,
        notes: null,
        mediaType: 'photo',
        mediaId: photo.fileId,
      }, settings);
    } else {
      bot.sendMessage(chatId, "Couldn't understand the time. Try again: \"in 30 minutes\" or \"at 3pm\"");
      pendingPhotos.set(String(chatId), photo); // re-store
    }
    return;
  }

  // Check for pending "YES" confirmation for clear all
  if (pendingClearAll.has(String(chatId))) {
    pendingClearAll.delete(String(chatId));
    if (lower === 'yes') {
      handleClearAllConfirm(bot, msg);
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
    const settings = getSettings(String(chatId));
    const parsed = await parseReminderSmart(combined, settings.timezone);
    if (parsed && !parsed.needsInfo && parsed.remindAt) {
      return saveAndConfirm(chatId, parsed, settings);
    }
    bot.sendMessage(chatId, "Hmm, I still couldn't figure that out. Try: \"remind me at 3pm to call dentist\"");
    return;
  }

  // --- AI-first intent classification ---
  const settings = getSettings(String(chatId));
  const activeReminders = getActiveReminders(String(chatId));
  const aiResult = await classifyIntent(text, settings.timezone, new Date().toISOString(), activeReminders);

  if (aiResult) {
    if (aiResult.intent === 'chat') {
      bot.sendMessage(chatId, aiResult.reply || "Hey! 👋 Need to set a reminder?");
      return;
    }

    if (aiResult.intent === 'command') {
      const cmd = aiResult.command;
      if (cmd === 'menu' || cmd === 'start') { handleMenu(bot, msg); return; }
      if (cmd === 'list') { handleList(bot, msg); return; }
      if (cmd === 'help') { handleHelp(bot, msg); return; }
      if (cmd === 'today') { handleToday(bot, msg); return; }
      if (cmd === 'clear_all') { handleClearAll(bot, msg); return; }
      if (cmd === 'clear_today') { handleClearToday(bot, msg); return; }
      if (cmd === 'pause') { handlePause(bot, msg); return; }
      if (cmd === 'resume') { handleResume(bot, msg); return; }
      if (cmd === 'undo') { handleUndo(bot, msg); return; }
      if (cmd === 'summary') { handleWeeklySummary(bot, msg); return; }
      if (cmd === 'repeat') {
        const last = getLastCreated(String(chatId));
        if (!last) { bot.sendMessage(chatId, 'Nothing to repeat.'); return; }
        saveAndConfirm(chatId, last, settings);
        return;
      }
      if (cmd === 'timezone' && aiResult.args) { handleTimezone(bot, msg, [null, aiResult.args]); return; }
      if (cmd === 'digest' && aiResult.args) { handleDigest(bot, msg, [null, aiResult.args]); return; }
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
          if (r) { cancelReminder(id); deactivateReminder(id); names.push(r.text); }
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
            updateTime(id, new Date(aiResult.newTime).toISOString());
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
            updateText(id, aiResult.newText);
            bot.sendMessage(chatId, `✅ Updated #${id}: "${aiResult.newText}"`);
          }
        }
        return;
      }
      if (aiResult.action === 'add_note') {
        for (const id of ids) {
          const r = activeReminders.find(rem => rem.id === id);
          if (r && aiResult.note) {
            addNoteToReminder(id, aiResult.note);
            bot.sendMessage(chatId, `📝 Note added to "${r.text}": ${aiResult.note}`);
          }
        }
        return;
      }
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
            mediaType: urlMatch ? 'link' : null,
            mediaId: urlMatch ? urlMatch[1] : null,
          };
          saveAndConfirm(chatId, parsed, settings);
        }
      }
      if (reminders.length > 0) return;
    }
  }

  // --- Fallback: try chrono-node parser (if AI unavailable or returned nothing useful) ---
  const parsed = parseReminder(text, settings.timezone);

  if (parsed) {
    saveAndConfirm(chatId, parsed, settings);
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

function saveAndConfirm(chatId, parsed, settings) {
  trackLastCreated(chatId, parsed);

  const id = createReminder({
    chatId: String(chatId),
    text: parsed.text,
    remindAt: parsed.remindAt.toISOString(),
    cronExpr: parsed.cronExpr,
    timezone: settings.timezone,
    category: parsed.category,
  });

  // Save notes if present
  if (parsed.notes) {
    addNoteToReminder(id, parsed.notes);
  }

  // Save media if present
  if (parsed.mediaType && parsed.mediaId) {
    attachMedia(id, parsed.mediaType, parsed.mediaId);
  }

  const reminder = {
    id,
    chat_id: String(chatId),
    text: parsed.text,
    remind_at: parsed.remindAt.toISOString(),
    cron_expr: parsed.cronExpr,
    category: parsed.category,
  };
  scheduleReminder(reminder);

  const timeStr = formatTime(parsed.remindAt.toISOString(), settings.timezone);
  const relTime = relativeTime(parsed.remindAt);
  const recurLabel = parsed.cronExpr ? '\nRecurring' : '';
  const noteLabel = parsed.notes ? `\nNote: ${parsed.notes}` : '';
  const mediaLabel = parsed.mediaType === 'photo' ? '\n📷 Photo attached' : parsed.mediaType === 'link' ? `\n🔗 ${parsed.mediaId}` : '';

  bot.sendMessage(
    chatId,
    `✅ *${parsed.text}*\n${timeStr} (in ${relTime})${recurLabel}${noteLabel}${mediaLabel}`,
    { parse_mode: 'Markdown' }
  );
}
