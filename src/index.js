import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import {
  createReminder, getSettings, getReminder,
  snoozeReminder as dbSnooze, deactivateReminder,
  incrementSnoozeCount, getSnoozeCount, resetSnoozeCount,
  clearIgnoredSince, logCompletedReminder,
} from './db.js';
import { parseReminderSmart } from './parser.js';
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

// --- Natural language message handler ---

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const lower = text.toLowerCase();

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
    // Combine original message with the answer
    const combined = `${ctx.originalText} (${text})`;
    const settings = getSettings(String(chatId));
    const parsed = await parseReminderSmart(combined, settings.timezone);
    if (parsed && !parsed.needsInfo && parsed.remindAt) {
      return saveAndConfirm(chatId, parsed, settings);
    }
    bot.sendMessage(chatId, "I still couldn't understand. Try something like:\n\"remind me at 3pm to call dentist\"");
    return;
  }

  // Natural text shortcuts
  if (['hi', 'hey', 'hello', 'menu', 'yo', 'sup', "what's up", 'whats up', 'wassup', 'whaddup'].includes(lower)) {
    handleMenu(bot, msg); return;
  }
  if (['view', 'list', 'reminders', 'my reminders'].includes(lower)) {
    handleList(bot, msg); return;
  }
  if (['clear all', 'reset'].includes(lower)) {
    handleClearAll(bot, msg); return;
  }
  if (['today', "today's reminders", 'todays reminders', 'list today'].includes(lower)) {
    handleToday(bot, msg); return;
  }
  if (['clear today', 'remove today', "remove today's reminders", "clear today's reminders"].includes(lower)) {
    handleClearToday(bot, msg); return;
  }
  if (lower === 'pause') { handlePause(bot, msg); return; }
  if (lower === 'resume') { handleResume(bot, msg); return; }
  if (lower === 'help') { handleHelp(bot, msg); return; }
  if (lower === 'undo') { handleUndo(bot, msg); return; }
  if (lower === 'summary' || lower === 'weekly' || lower === 'stats') { handleWeeklySummary(bot, msg); return; }

  // Repeat last reminder
  if (lower === 'repeat' || lower === 'again' || lower === 'repeat last') {
    const last = getLastCreated(String(chatId));
    if (!last) { bot.sendMessage(chatId, 'Nothing to repeat. Set a reminder first!'); return; }
    const settings = getSettings(String(chatId));
    saveAndConfirm(chatId, last, settings);
    return;
  }

  // Natural conversation check (before reminder parsing)
  const convoResponse = getConversationalResponse(text);
  if (convoResponse) {
    bot.sendMessage(chatId, convoResponse);
    return;
  }

  // Try smart parsing (AI first, then chrono fallback)
  const settings = getSettings(String(chatId));
  const parsed = await parseReminderSmart(text, settings.timezone);

  if (!parsed) {
    bot.sendMessage(chatId,
      "Hey! 😊 I'm not sure what you mean.\n\n" +
      "If you want to set a reminder, try:\n" +
      '• "remind me at 3pm to call dentist"\n' +
      '• "in 30 minutes check the oven"\n\n' +
      "Or just chat — I'm friendly! Send /menu for options."
    );
    return;
  }

  // AI needs more info
  if (parsed.needsInfo) {
    pendingClarification.set(String(chatId), { originalText: text });
    bot.sendMessage(chatId, `🤔 ${parsed.needsInfo}`);
    return;
  }

  saveAndConfirm(chatId, parsed, settings);
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
  const catEmoji = { health: '🏥', work: '💼', personal: '🏠' }[parsed.category] || '';
  const recurLabel = parsed.cronExpr ? '\n🔁 Recurring' : '';

  bot.sendMessage(
    chatId,
    `✅ Reminder set! ${catEmoji}\n\n📝 *${parsed.text}*\n⏰ ${timeStr} (in ${relTime})${recurLabel}`,
    { parse_mode: 'Markdown' }
  );
}
