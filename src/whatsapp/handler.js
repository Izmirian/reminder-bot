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
  createReminder, createNoTimeReminder, getNoTimeReminders, getActiveReminders, getReminder, deactivateReminder,
  markReminderCancelled,
  deactivateAllReminders, deactivateTodaysReminders, pauseAllReminders,
  resumeAllReminders, getPausedReminders, getSettings, setTimezone,
  setDailyDigest, setLocation, setQuietHours, setGoogleTokens, updateReminderText, updateReminderTime,
  getTodaysReminders, getLastDeactivated, reactivateReminder,
  getWeeklyStats, attachMedia, attachMediaWithData, getLastReminder, addNoteToReminder, searchReminders,
  updateStreak, getAllStreaks,
  createUrlMonitor, getUserMonitors, deactivateMonitor,
  snoozeReminder as dbSnooze,
  incrementSnoozeCount, getSnoozeCount, resetSnoozeCount,
  clearIgnoredSince, logCompletedReminder, assignReminderToProject,
} from '../db.js';
import {
  scheduleReminder, cancelReminder,
  snoozeReminder as schedSnooze,
  messageReminderMap,
} from './scheduler.js';
import { detectRecurringPattern } from '../patterns.js';
import { getConversationalResponse } from '../conversation.js';
import { forwardToThoughts, thoughtsEnabled, chatAllowed, extractIdeaPrefix, thoughtReply } from '../thoughts-forward.js';
import { addPin, logAction } from '../db.js';
import {
  handleListIntent, handleContactIntent, handleJournalIntent,
  handleMemoryIntent, handleExpenseIntent, handleTimerIntent, handleSummarizeIntent,
  buildDashboard, handleProjectIntent, handlePinIntent, handleFollowupIntent,
  handleResearchIntent, handleEmailIntent, handleUndo, checkConflicts,
  orderRemindersForDisplay, wantsListAfterAction,
} from '../assistant.js';

// Track state
const pendingClearAll = new Set();
const pendingClarification = new Map();
const pendingPhotos = new Map(); // from -> { waMediaId, mimeType, caption }
const pendingProjectTask = new Map(); // from -> { taskText, projectId, projectName }

// Cleanup stale pending entries every 30 minutes
setInterval(() => {
  if (pendingClearAll.size > 0) pendingClearAll.clear();
  if (pendingClarification.size > 0) { console.log(`[WA Cleanup] Clearing ${pendingClarification.size} stale clarifications`); pendingClarification.clear(); }
  if (pendingPhotos.size > 0) { console.log(`[WA Cleanup] Clearing ${pendingPhotos.size} stale pending photos`); pendingPhotos.clear(); }
  if (pendingProjectTask.size > 0) pendingProjectTask.clear();
}, 1800000);
const lastCreated = new Map();
const lastCreatedId = new Map(); // from -> last reminder ID

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

// Per-user FIFO queue — prevents race conditions without dropping messages
const userQueues = new Map(); // from → { processing: boolean, queue: [], startedAt: number }

export async function handleTextMessage(from, text, quotedMsgId = null) {
  if (!userQueues.has(from)) userQueues.set(from, { processing: false, queue: [], startedAt: 0 });
  const entry = userQueues.get(from);

  // Safety: if processing has been stuck for >60s, reset it (prevents permanent lockup)
  if (entry.processing && entry.startedAt && (Date.now() - entry.startedAt > 60000)) {
    console.warn(`[Queue] Resetting stuck queue for ${from} after 60s`);
    entry.processing = false;
    entry.queue = [];
  }

  // If already processing, queue this message instead of dropping it
  if (entry.processing) {
    if (entry.queue.length < 5) { // Cap queue to prevent abuse
      entry.queue.push({ text, quotedMsgId });
    } else {
      // Queue full — don't silently swallow; tell the user we're behind.
      sendTextMessage(from, "I'm still working through your earlier messages — one sec.").catch(() => {});
    }
    return;
  }

  entry.processing = true;
  entry.startedAt = Date.now();
  // Run one message with its own guard so a failure can't strand the queue or go silent.
  const runOne = async (msgText, quoted) => {
    try {
      await _handleTextMessage(from, msgText, quoted);
    } catch (err) {
      console.error(`[Handler] Error processing message from ${from}:`, err.message);
      await sendTextMessage(from, 'Something went wrong on my end — please try that again.').catch(() => {});
    }
  };
  try {
    await runOne(text, quotedMsgId);
    // Process queued messages FIFO; each is independently guarded.
    while (entry.queue.length > 0) {
      const next = entry.queue.shift();
      await runOne(next.text, next.quotedMsgId);
    }
  } finally {
    entry.processing = false;
    entry.startedAt = 0;
    // Cleanup stale entries
    if (userQueues.size > 500) {
      const first = userQueues.keys().next().value;
      userQueues.delete(first);
    }
  }
}

// Capture a thought/idea/note: ALWAYS pin it (durable — so important things are
// never lost even if the graph is down/unconfigured) AND add it to the idea graph
// when configured. Reminders never reach this path. Returns the user-facing reply.
async function captureThought(from, text, { mediaBuffer = null, mediaMime = null, sourceType = 'text', pinSource = 'idea' } = {}) {
  const clean = (text || '').trim();
  if (!clean && !mediaBuffer) return '⚠️ Nothing to capture.';

  let pinned = false;
  try {
    const pinId = await addPin(from, clean || '(media note)', pinSource);
    await logAction(from, 'pin', { id: pinId, content: clean });
    pinned = true;
  } catch (e) { console.error('[Capture] pin failed:', e.message); }

  const graphConfigured = thoughtsEnabled() && chatAllowed(from);
  let graph = null;
  if (graphConfigured) {
    graph = await forwardToThoughts({ chatId: from, text: clean, mediaBuffer, mediaMime, source: 'whatsapp', sourceType });
  }
  return thoughtReply({ pinned, graph, graphConfigured });
}

async function _handleTextMessage(from, text, quotedMsgId = null) {
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
          await markReminderCancelled(reminderId);
          return sendTextMessage(from, `Cancelled "${reminder.text}"`);
        }

        // Route through AI with this specific reminder as context
        const settings = await getSettings(from);
        const aiResult = await classifyIntent(text.trim(), settings.timezone, new Date().toISOString(), [reminder]);
        if (aiResult?.intent === 'action') {
          if (aiResult.action === 'cancel') {
            cancelReminder(reminderId);
            await markReminderCancelled(reminderId);
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
        // Check for snooze-like patterns — "30 min", "1 hour", or just a bare number "5" or "30" or "1h"
        const snoozeMatch = text.match(/^(\d+)\s*(min|minute|hour|hr|h|m)?$/i) || text.match(/(\d+)\s*(min|minute|hour|hr)/i);
        if (snoozeMatch) {
          let mins = parseInt(snoozeMatch[1], 10);
          if (/^(hour|hr|h)$/i.test(snoozeMatch[2] || '')) mins *= 60;
          // Bare number: if >0 and <=120, treat as minutes. If just "1" or "2", treat as hours.
          if (!snoozeMatch[2] && mins <= 3) mins *= 60; // "1" = 1 hour, "2" = 2 hours
          await dbSnooze(reminderId, new Date(Date.now() + mins * 60 * 1000).toISOString());
          await schedSnooze(reminderId, mins);
          const label = mins >= 60 ? `${mins / 60} hour(s)` : `${mins} minutes`;
          return sendTextMessage(from, `Snoozed "${reminder.text}" for ${label}`);
        }
      }
    }
  }

  // Shorthand: "also [note]" adds note to last reminder, "and [reminder]" creates another at same time
  const lastId = lastCreatedId.get(from);
  if (lastId && /^also\s+/i.test(lower)) {
    const note = text.trim().replace(/^also\s+/i, '');
    if (note) {
      await addNoteToReminder(lastId, note);
      return sendTextMessage(from, `Note added: ${note}`);
    }
  }
  if (lastId && /^and\s+/i.test(lower)) {
    const extraText = text.trim().replace(/^and\s+/i, '');
    if (extraText) {
      const last = lastCreated.get(from);
      if (last?.remindAt) {
        const settings2 = await getSettings(from);
        await saveAndConfirm(from, { text: extraText, remindAt: last.remindAt, cronExpr: last.cronExpr, category: last.category, priority: last.priority }, settings2);
        return;
      }
    }
  }

  // Pending clear all confirmation
  if (pendingClearAll.has(from)) {
    pendingClearAll.delete(from);
    if (lower === 'yes') return doClearAll(from);
    return sendTextMessage(from, 'Clear all cancelled.');
  }

  // Pending project task awaiting a time
  if (pendingProjectTask.has(from)) {
    const task = pendingProjectTask.get(from);
    const settings = await getSettings(from);
    const aiResult = await classifyIntent(`remind me ${text.trim()} to ${task.taskText}`, settings.timezone, new Date().toISOString(), []);
    if (aiResult?.intent === 'reminder' && aiResult.reminders?.[0]?.remindAt) {
      pendingProjectTask.delete(from);
      const r = aiResult.reminders[0];
      const when = new Date(r.remindAt);
      if (isNaN(when.getTime())) return sendTextMessage(from, "I couldn't read that time — try \"tomorrow 5pm\".");
      const id = await createReminderAndSchedule(from, {
        text: task.taskText, remindAt: when, cronExpr: r.cronExpr || null, category: null, notes: null,
      }, settings);
      await assignReminderToProject(id, task.projectId);
      const timeStr = formatTime(when.toISOString(), settings.timezone);
      return sendTextMessage(from, `✅ Added to *${task.projectName}*: ${task.taskText}\n${timeStr}`);
    }
    // Couldn't parse a time — keep the pending task and re-ask instead of going silent.
    return sendTextMessage(from, `When should I remind you about "${task.taskText}"? (e.g. "tomorrow 5pm")`);
  }

  // Pending photo awaiting a time or action
  if (pendingPhotos.has(from)) {
    const photo = pendingPhotos.get(from);

    // Check if user wants to analyze the pending photo
    if (/^(analyz|read|summariz|explain|describe|what|report|extract|check|review|translate)/i.test(lower) && photo.buffer) {
      pendingPhotos.delete(from);
      const { analyzeImage } = await import('../analyze.js');
      const result = await analyzeImage(photo.buffer, photo.mimeType || 'image/jpeg', text.trim());
      return sendTextMessage(from, result);
    }

    // Check if user wants to save the photo as a document
    if (/^save/i.test(lower) && photo.buffer) {
      pendingPhotos.delete(from);
      const { saveDocument } = await import('../db.js');
      await saveDocument(from, 'photo', text.trim().replace(/^save\s*/i, '') || 'Saved photo', photo.mimeType, photo.buffer);
      return sendTextMessage(from, 'Photo saved. Say "show my documents" to see saved files.');
    }

    const settings = await getSettings(from);
    const aiResult = await classifyIntent(`remind me ${text.trim()} to ${photo.text}`, settings.timezone, new Date().toISOString(), []);
    if (aiResult?.intent === 'reminder' && aiResult.reminders?.[0]?.remindAt) {
      pendingPhotos.delete(from);
      const r = aiResult.reminders[0];
      const id = await createReminderAndSchedule(from, {
        text: photo.text, remindAt: new Date(r.remindAt), cronExpr: null, category: null, notes: null,
      }, settings);
      await attachMediaWithData(id, 'wa_image', photo.mimeType || 'image/jpeg', photo.buffer);
      const timeStr = formatTime(new Date(r.remindAt).toISOString(), settings.timezone);
      const relTime = relativeTime(new Date(r.remindAt));
      return sendTextMessage(from, `✅ *${photo.text}*\n${timeStr} (in ${relTime})\nPhoto attached`);
    }
    if (aiResult?.needsInfo) {
      // Keep photo pending, ask for more details
      return sendTextMessage(from, aiResult.needsInfo);
    }
    // Only clear pending photo on unrecoverable failure
    pendingPhotos.delete(from);
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

  // Explicit thought capture ("idea:", "thought:", "note:", "#…") — pin + graph.
  // Pins even if the graph is unconfigured, so nothing is lost. Gated by sender so
  // strangers can't write to the owner's pins/graph; others fall through.
  if (chatAllowed(from)) {
    const ideaText = extractIdeaPrefix(text);
    if (ideaText) return sendTextMessage(from, await captureThought(from, ideaText, { pinSource: 'note' }));
  }

  // --- AI-first intent classification ---
  const settings = await getSettings(from);
  // Order to match sendList's letter assignment so "cancel a" hits the reminder the user saw.
  const activeRems = orderRemindersForDisplay(await getActiveReminders(from));
  const aiResult = await classifyIntent(text.trim(), settings.timezone, new Date().toISOString(), activeRems, from);

  // Only log reschedule-related intents so we can diagnose the bug (keeps normal logs clean)
  if (aiResult && (aiResult.intent === 'action' || /switch|reschedule|move/i.test(text))) {
    try {
      console.log(`[WA Action] msg="${text.substring(0, 80)}" intent=${aiResult.intent} action=${aiResult.action} ids=${JSON.stringify(aiResult.ids || [])} updates=${JSON.stringify(aiResult.updates || []).substring(0, 200)}`);
    } catch {}
  }

  if (aiResult) {
    if (aiResult.intent === 'chat') {
      // Auto-save important dates mentioned in conversation
      if (aiResult.autoSave?.date && aiResult.autoSave?.event) {
        try {
          const { addPin } = await import('../db.js');
          await addPin(from, `${aiResult.autoSave.event}: ${aiResult.autoSave.date}`);
        } catch {}
      }
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
      if (cmd === 'undo') return handleUndoCommand(from);
      if (cmd === 'summary') return handleWeekly(from);
      if (cmd === 'dashboard') {
        const settings2 = await getSettings(from);
        return sendTextMessage(from, await buildDashboard(from, settings2.timezone));
      }
      if (cmd === 'streaks') {
        const streaks = await getAllStreaks(from);
        if (streaks.length === 0) return sendTextMessage(from, 'No active streaks yet. Complete recurring reminders to build streaks!');
        let msg2 = '*Your Streaks*\n';
        for (const s of streaks) msg2 += `\n*${s.reminder_text}*\nCurrent: ${s.current_streak} days | Best: ${s.longest_streak} days`;
        return sendTextMessage(from, msg2);
      }
      if (cmd === 'repeat') return handleRepeat(from);
      if (cmd === 'location' && aiResult.args) {
        await setLocation(from, aiResult.args);
        return sendTextMessage(from, `Location set to *${aiResult.args}*\nWeather will show in your morning briefing.`);
      }
      if (cmd === 'quiet_hours') {
        const { parseQuietSpec, formatClock } = await import('../quiet.js');
        const arg = (aiResult.args || '').trim().toLowerCase();
        const cur = await getSettings(from);
        if (arg === 'show' || arg === '') {
          if (cur.quiet_start && cur.quiet_end) return sendTextMessage(from, `Quiet hours: *${formatClock(cur.quiet_start)} → ${formatClock(cur.quiet_end)}*\nNon-urgent reminders are held until they end. Say "turn off quiet hours" to disable.`);
          return sendTextMessage(from, 'Quiet hours are off. Set them like "quiet hours 11pm to 8am".');
        }
        const spec = parseQuietSpec(arg);
        if (!spec) return sendTextMessage(from, 'Try "quiet hours 11pm to 8am" or "turn off quiet hours".');
        await setQuietHours(from, spec.start, spec.end);
        if (!spec.start) return sendTextMessage(from, 'Quiet hours turned off. Reminders will fire any time.');
        return sendTextMessage(from, `Quiet hours set: *${formatClock(spec.start)} → ${formatClock(spec.end)}*\nNon-urgent reminders will wait until then. Urgent ones still come through.`);
      }
      if (cmd === 'connect_calendar') {
        const { getAuthUrl, isConfigured } = await import('../google-calendar.js');
        if (!isConfigured()) return sendTextMessage(from, 'Google Calendar not configured yet.');
        const url = getAuthUrl(from);
        return sendTextMessage(from, `Open this link to connect Google Calendar:\n${url}`);
      }
      if (cmd === 'disconnect_calendar') {
        await setGoogleTokens(from, null);
        return sendTextMessage(from, 'Google Calendar disconnected.');
      }
    }

    if (aiResult.intent === 'action') {
      if (aiResult.needsInfo) {
        return sendTextMessage(from, `🤔 ${aiResult.needsInfo}`);
      }
      // "cancel a and show the list" — re-render after the action so the user
      // sees the re-lettered list instead of referencing now-stale letters.
      const wantsListAfter = wantsListAfterAction(text);
      const ids = aiResult.ids || [];
      if (aiResult.action === 'cancel') {
        // For "cancel all/everything", use the active list as source of truth (AI ids may be stale)
        const isBulkRequest = (/\b(all|everything|both)\b/i.test(text) || /\bevery\s+(reminder|one|single|task)\b/i.test(text));
        // Bulk cancel of 3+ is destructive and only single-undo — confirm first (mirrors "clear all").
        if (isBulkRequest && activeRems.length > 2) {
          pendingClearAll.add(from);
          return sendTextMessage(from, `⚠️ Cancel *all ${activeRems.length}* reminders? Reply *YES* to confirm, or anything else to keep them.`);
        }
        const targetIds = isBulkRequest ? activeRems.map(r => r.id) : ids;
        if (targetIds.length === 0 && isBulkRequest) {
          return sendTextMessage(from, "You don't have any active reminders to cancel.");
        }
        if (targetIds.length === 0) {
          return sendTextMessage(from, "Which reminder should I cancel? Try \"cancel gold exchange\" or \"cancel all\".");
        }
        const names = [];
        for (const id of targetIds) {
          const r = activeRems.find(rem => rem.id === id);
          if (r) { cancelReminder(id); await markReminderCancelled(id); names.push(r.text); }
        }
        if (names.length === 0) {
          return sendTextMessage(from, `Couldn't find those reminders. Active:\n${activeRems.map(r => `  • ${r.text}`).join('\n') || '  (none)'}`);
        }
        if (names.length === 1) return confirmActionAndMaybeList(from, `❌ Cancelled "${names[0]}"`, wantsListAfter);
        return confirmActionAndMaybeList(from, `❌ Cancelled ${names.length} reminders:\n${names.map(n => `  • ${n}`).join('\n')}`, wantsListAfter);
      }
      if (aiResult.action === 'reschedule') {
        try {
          // Build a normalized list of updates: [{id, newTime}, ...]
          let updates = [];
          if (Array.isArray(aiResult.updates) && aiResult.updates.length > 0) {
            updates = aiResult.updates;
          } else if (ids.length > 0 && aiResult.newTime) {
            updates = ids.map(id => ({ id, newTime: aiResult.newTime }));
          }

          if (updates.length === 0) {
            console.warn(`[WA Reschedule] No valid updates — ids=${JSON.stringify(ids)} newTime=${aiResult.newTime} updates=${JSON.stringify(aiResult.updates)}`);
            return sendTextMessage(from, "I need both the reminder(s) and the new time(s). Try: \"move gold exchange to 10:30am\".");
          }

          const results = [];
          const notFound = [];
          for (const u of updates) {
            const r = activeRems.find(rem => rem.id === u.id);
            if (!r) { notFound.push(u.id); continue; }
            if (!u.newTime) { notFound.push(u.id); continue; }
            cancelReminder(u.id);
            await updateReminderTime(u.id, new Date(u.newTime).toISOString());
            scheduleReminder({ ...r, remind_at: new Date(u.newTime).toISOString() });
            const timeStr = new Date(u.newTime).toLocaleString('en-US', {
              timeZone: settings.timezone, weekday: 'short', month: 'short', day: 'numeric',
              hour: '2-digit', minute: '2-digit', hour12: true,
            });
            results.push(`"${r.text}" → ${timeStr}`);
          }

          if (results.length > 0) {
            let msg = `✅ Rescheduled:\n${results.map(r => `  • ${r}`).join('\n')}`;
            if (notFound.length > 0) msg += `\n\n(Couldn't find: ${notFound.join(', ')})`;
            return confirmActionAndMaybeList(from, msg, wantsListAfter);
          }
          return sendTextMessage(from, `Couldn't find those reminders to reschedule. Active: ${activeRems.map(r => `#${r.id} ${r.text}`).join(', ')}`);
        } catch (err) {
          console.error('[WA Reschedule] Error:', err.message, err.stack);
          return sendTextMessage(from, `Reschedule failed: ${err.message}`);
        }
      }
      if (aiResult.action === 'edit') {
        if (ids.length === 0) {
          return sendTextMessage(from, "Which reminder should I edit? Try: \"change gold exchange to silver exchange\".");
        }
        if (!aiResult.newText) {
          return sendTextMessage(from, "What should I change the reminder to? Try: \"change [reminder] to [new text]\".");
        }
        const updated = [];
        for (const id of ids) {
          const r = activeRems.find(rem => rem.id === id);
          if (r) {
            await updateReminderText(id, aiResult.newText);
            updated.push(r.text);
          }
        }
        if (updated.length === 0) {
          return sendTextMessage(from, `Couldn't find those reminders to edit. Active:\n${activeRems.map(r => `  • ${r.text}`).join('\n') || '  (none)'}`);
        }
        if (updated.length === 1) return confirmActionAndMaybeList(from, `✅ Updated "${updated[0]}" → "${aiResult.newText}"`, wantsListAfter);
        return confirmActionAndMaybeList(from, `✅ Updated ${updated.length} reminders to "${aiResult.newText}"`, wantsListAfter);
      }
      if (aiResult.action === 'complete') {
        const isBulkRequest = (/\b(all|everything|both)\b/i.test(text) || /\bevery\s+(reminder|one|single|task)\b/i.test(text));
        // For bulk requests, ignore AI's ids (which may be stale) — use current active list
        let targetIds = isBulkRequest ? activeRems.map(r => r.id) : ids;

        // Empty active list when user asked to clear everything → friendly message
        if (targetIds.length === 0 && isBulkRequest) {
          return sendTextMessage(from, "You don't have any active reminders to mark done. 🎉");
        }
        if (targetIds.length === 0) {
          return sendTextMessage(from, "Which reminder is done? Reply with the name, e.g. \"done with gold exchange\".");
        }

        const completed = [];
        for (const id of targetIds) {
          const r = activeRems.find(rem => rem.id === id);
          if (r) {
            cancelReminder(id);
            await deactivateReminder(id);
            await logCompletedReminder({ chatId: from, text: r.text, remindAt: r.remind_at });
            if (r.cron_expr) { await updateStreak(from, r.text, r.cron_expr); }
            completed.push(r.text);
          }
        }
        if (completed.length === 0) {
          // AI returned IDs but none are currently active (stale)
          if (activeRems.length === 0) {
            return sendTextMessage(from, "You don't have any active reminders to mark done. 🎉");
          }
          return sendTextMessage(from, `Couldn't find those specific reminders. Your active ones:\n${activeRems.map(r => `  • ${r.text}`).join('\n')}\n\nReply "done with [name]" or "mark all as done".`);
        }
        if (completed.length === 1) return confirmActionAndMaybeList(from, `✅ Done: "${completed[0]}"`, wantsListAfter);
        return confirmActionAndMaybeList(from, `✅ Marked ${completed.length} as done:\n${completed.map(t => `  • ${t}`).join('\n')}`, wantsListAfter);
      }
      if (aiResult.action === 'add_note') {
        if (ids.length === 0) {
          return sendTextMessage(from, "Which reminder should the note go on? Try: \"add note to gold exchange: bring receipt\".");
        }
        const added = [];
        for (const id of ids) {
          const r = activeRems.find(rem => rem.id === id);
          if (r && aiResult.note) {
            await addNoteToReminder(id, aiResult.note);
            added.push(r.text);
          }
        }
        if (added.length === 0) return sendTextMessage(from, "Couldn't find those reminders to add a note to.");
        return confirmActionAndMaybeList(from, `📝 Note added to ${added.length === 1 ? `"${added[0]}"` : `${added.length} reminders`}: ${aiResult.note}`, wantsListAfter);
      }
    }

    if (aiResult.intent === 'monitor') {
      if (aiResult.action === 'create' && aiResult.url) {
        await createUrlMonitor({ chatId: from, url: aiResult.url, label: aiResult.label, checkType: aiResult.type || 'change' });
        const typeLabel = aiResult.type === 'price' ? 'price changes' : 'content changes';
        return sendTextMessage(from, `Watching for ${typeLabel}:\n*${aiResult.label || aiResult.url}*\nChecks every 30 minutes.`);
      }
      if (aiResult.action === 'list') {
        const monitors = await getUserMonitors(from);
        if (monitors.length === 0) return sendTextMessage(from, 'No active monitors. Say "watch [url] for changes" to start.');
        let msg = '*Your URL Monitors*\n';
        for (const m of monitors) {
          const typeLabel = m.check_type === 'price' ? 'price' : 'changes';
          const checked = m.last_checked ? new Date(m.last_checked).toLocaleString('en-US', { timeZone: settings.timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never';
          msg += `\n*#${m.id}* ${m.label || m.url}\n  Watching: ${typeLabel} | Last checked: ${checked}`;
        }
        return sendTextMessage(from, msg);
      }
      if (aiResult.action === 'stop' && aiResult.id) {
        await deactivateMonitor(aiResult.id, from);
        return sendTextMessage(from, `Stopped monitoring #${aiResult.id}`);
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

    if (aiResult.intent === 'list') return sendTextMessage(from, await handleListIntent(from, aiResult));
    if (aiResult.intent === 'contact') return sendTextMessage(from, await handleContactIntent(from, aiResult));
    if (aiResult.intent === 'journal') return sendTextMessage(from, await handleJournalIntent(from, aiResult, settings.timezone));
    if (aiResult.intent === 'memory') return sendTextMessage(from, await handleMemoryIntent(from, aiResult));
    if (aiResult.intent === 'idea' && chatAllowed(from)) {
      return sendTextMessage(from, await captureThought(from, aiResult.text || text.trim(), { pinSource: 'idea' }));
    }
    if (aiResult.intent === 'expense') return sendTextMessage(from, await handleExpenseIntent(from, aiResult));
    if (aiResult.intent === 'timer') return sendTextMessage(from, handleTimerIntent(from, aiResult, (msg) => sendTextMessage(from, msg)));
    if (aiResult.intent === 'summarize') return sendTextMessage(from, await handleSummarizeIntent(aiResult.url, from));
    if (aiResult.intent === 'project') {
      const result = await handleProjectIntent(from, aiResult, settings.timezone);
      if (result?.needsTime) {
        // Dedicated pending map — NOT pendingPhotos (which would attach a bogus image).
        pendingProjectTask.set(from, { taskText: result.taskText, projectId: result.projectId, projectName: aiResult.name || 'project' });
        return sendTextMessage(from, `Adding "${result.taskText}" to ${aiResult.name || 'project'}. When should I remind you?`);
      }
      return sendTextMessage(from, result);
    }
    if (aiResult.intent === 'pin') {
      // A saved pin/note IS a thought: pin it AND add it to the graph (allowed
      // senders only). list/remove keep their existing behavior.
      if (aiResult.action === 'save' && aiResult.content && chatAllowed(from)) {
        return sendTextMessage(from, await captureThought(from, aiResult.content, { pinSource: 'note' }));
      }
      return sendTextMessage(from, await handlePinIntent(from, aiResult));
    }
    if (aiResult.intent === 'followup') return sendTextMessage(from, await handleFollowupIntent(from, aiResult));
    if (aiResult.intent === 'research') return sendTextMessage(from, await handleResearchIntent(aiResult, from));
    if (aiResult.intent === 'email') {
      const draft = handleEmailIntent(aiResult);
      return sendTextMessage(from, `*Email Draft*\nTo: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}\n\n_Send this from your email app._`);
    }
    if (aiResult.intent === 'github') {
      const { handleGithubQuery } = await import('../github.js');
      return sendTextMessage(from, await handleGithubQuery(aiResult.query));
    }

    if (aiResult.intent === 'reminder') {
      const reminders = aiResult.reminders || [];
      let created = 0;
      const noTimeSaved = [];
      for (const r of reminders) {
        // No time given → capture as a no-time item instead of asking.
        if (!r.remindAt && r.text) {
          await createNoTimeReminder({ chatId: from, text: r.text, category: r.category || detectCategory(r.text), priority: r.priority });
          noTimeSaved.push(r.text);
          continue;
        }
        if (r.remindAt) {
          // Handle "after this meeting" — check calendar for next event end time
          let actualRemindAt = r.remindAt;
          if (typeof r.remindAt === 'string' && r.remindAt.includes('AFTER_MEETING')) {
            try {
              const { getEventsNear, isConfigured } = await import('../google-calendar.js');
              if (isConfigured()) {
                const events = await getEventsNear(from, new Date().toISOString(), 180);
                const currentOrNext = events.find(e => e.end && new Date(e.end) > new Date());
                if (currentOrNext?.end) {
                  actualRemindAt = new Date(new Date(currentOrNext.end).getTime() + 5 * 60000).toISOString(); // 5 min after meeting ends
                  await sendTextMessage(from, `Setting reminder for after "${currentOrNext.summary}" ends`);
                } else {
                  return sendTextMessage(from, "No upcoming meetings found on your calendar. What time should I set the reminder?");
                }
              } else {
                return sendTextMessage(from, "Google Calendar not connected. Say 'connect google calendar' first, or give me a specific time.");
              }
            } catch { actualRemindAt = new Date(Date.now() + 60 * 60000).toISOString(); } // fallback: 1 hour
          }
          const when = new Date(actualRemindAt);
          if (isNaN(when.getTime())) continue; // skip un-parseable times rather than crash in saveAndConfirm
          const parsed = {
            text: r.text,
            remindAt: when,
            cronExpr: r.cronExpr || null,
            category: r.category || detectCategory(r.text),
            priority: r.priority || 'normal',
            sharedWith: r.sharedWith || null,
          };
          await saveAndConfirm(from, parsed, settings);
          created++;
        }
      }
      // Safety net: AI flagged a missing time but gave no entries — capture the raw ask as no-time.
      if (created === 0 && noTimeSaved.length === 0 && (aiResult.needsInfo || reminders.length > 0)) {
        const t = text.trim().replace(/^(remind me( to| about)?|remember( to)?|note:?)\s*/i, '').trim() || text.trim();
        if (t) { await createNoTimeReminder({ chatId: from, text: t, category: detectCategory(t) }); noTimeSaved.push(t); }
      }
      if (noTimeSaved.length > 0) {
        const msg = noTimeSaved.length === 1
          ? `📝 Added to list: *${noTimeSaved[0]}*`
          : `📝 Added to list:${noTimeSaved.map(t => `\n  • ${t}`).join('')}`;
        await sendTextMessage(from, msg);
      }
      if (created > 0 || noTimeSaved.length > 0) return;
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

async function handleUndoCommand(from) {
  // Try universal undo first (pins, follow-ups, projects)
  const result = await handleUndo(from);
  if (result !== 'Nothing to undo.') return sendTextMessage(from, result);
  // Fall back to reminder undo
  const last = await getLastDeactivated(from);
  if (!last) return sendTextMessage(from, 'Nothing to undo.');
  await reactivateReminder(last.id);
  scheduleReminder({ ...last, active: 1 });
  return sendTextMessage(from, `Restored: "${last.text}"`);
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
    priority: parsed.priority, sharedWith: parsed.sharedWith, createdBy: from,
  });

  lastCreatedId.set(from, id);

  // Only schedule if the reminder is in the future
  if (parsed.remindAt.getTime() > Date.now()) {
    scheduleReminder({
      id, chat_id: from, text: parsed.text,
      remind_at: parsed.remindAt.toISOString(), cron_expr: parsed.cronExpr,
      category: parsed.category, priority: parsed.priority,
      shared_with: parsed.sharedWith ? JSON.stringify(parsed.sharedWith) : null,
    });
  }

  const timeStr = formatTime(parsed.remindAt.toISOString(), settings.timezone);
  const relTime = relativeTime(parsed.remindAt);
  const catEmoji = { health: '🏥', work: '💼', personal: '🏠' }[parsed.category] || '';
  const recurLabel = parsed.cronExpr ? '\n🔁 Recurring' : '';
  const priorityLabel = parsed.priority === 'urgent' ? '\nURGENT' : parsed.priority === 'low' ? '\nLow priority' : '';
  const sharedLabel = parsed.sharedWith?.length ? `\nShared with ${parsed.sharedWith.length} recipient${parsed.sharedWith.length === 1 ? '' : 's'}` : '';

  // Check for conflicts
  const conflict = await checkConflicts(from, parsed.remindAt.toISOString());
  const conflictLabel = conflict ? `\n${conflict}` : '';

  const apiResult = await sendTextMessage(from,
    `✅ Reminder set! ${catEmoji}\n\n📝 *${parsed.text}*\n⏰ ${timeStr} (in ${relTime})${recurLabel}${priorityLabel}${sharedLabel}${conflictLabel}`
  );
  // Track message ID for reply-to feature
  const wamid = apiResult?.messages?.[0]?.id;
  if (wamid) { messageReminderMap.set(wamid, id); if (messageReminderMap.size > 500) { [...messageReminderMap.keys()].slice(0, 100).forEach(k => messageReminderMap.delete(k)); } }
}

/**
 * Process a button reply (snooze / done).
 */
export async function handleButtonReply(from, buttonId) {
  // Extract reminder ID and verify ownership before any action
  const idMatch = buttonId.match(/:(\d+)/);
  if (idMatch) {
    const checkId = parseInt(idMatch[1], 10);
    const checkReminder = await getReminder(checkId);
    if (checkReminder && checkReminder.chat_id !== from) {
      console.warn(`[Security] User ${from} tried to act on reminder ${checkId} owned by ${checkReminder.chat_id}`);
      return;
    }
  }

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

    // Track streak for recurring reminders
    let streakMsg = '';
    if (reminder?.cron_expr) {
      const streak = await updateStreak(from, reminder.text, reminder.cron_expr);
      if (streak > 1) streakMsg = `\n${streak}-day streak!`;
    }

    await sendTextMessage(from, `✅ Done!${streakMsg}`);

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
    '🤖 *Your Assistant — Help*\n\n' +
    '*Reminders:*\n• "remind me at 3pm to call dentist"\n• "in 30 minutes check the oven"\n• "every day at 8am take vitamins"\n• *cancel 3* · *edit 3 to 5pm* · *clear all* · *pause*/*resume*\n\n' +
    '*Also try (just say it naturally):*\n' +
    '• *Lists:* "add milk to grocery list"\n' +
    '• *Expenses:* "spent 12 on lunch" · "how much this month?"\n' +
    '• *Notes/memory:* "remember my wifi is X" · "what\'s my wifi?"\n' +
    '• *Contacts:* "John\'s birthday is May 3"\n' +
    '• *Journal:* "journal: had a great day"\n' +
    '• *Follow-ups:* "follow up with Sarah in 3 days"\n' +
    '• *Summarize/research:* "summarize <link>" · "compare iPhone prices"\n' +
    '• *Voice notes:* just send one — I\'ll transcribe it\n\n' +
    '*Settings:*\n• *quiet hours 11pm to 8am* — hold non-urgent reminders overnight\n• *timezone Asia/Dubai* · *digest on*/*off* · *set location Amman*\n• *connect calendar* · *dashboard*'
  );
}

// Send an action confirmation, then re-render the list when the user asked for
// it in the same breath ("cancel a and show the list"). Re-rendering surfaces
// the freshly re-lettered list so the next letter reference resolves correctly.
async function confirmActionAndMaybeList(to, msg, wantsList) {
  await sendTextMessage(to, msg);
  if (wantsList) await sendList(to);
}

async function sendList(to) {
  const reminders = await getActiveReminders(to);
  const paused = await getPausedReminders(to);
  if (reminders.length === 0 && paused.length === 0) {
    return sendTextMessage(to, 'You have no reminders.\nJust type a reminder to set one!');
  }

  const settings = await getSettings(to);
  const todayStr = new Date().toISOString().split('T')[0];
  // Same canonical order the AI letters against (orderRemindersForDisplay).
  const ordered = orderRemindersForDisplay(reminders);
  const today = ordered.filter(r => r.remind_at && !r.cron_expr && String(r.remind_at).startsWith(todayStr));
  const upcoming = ordered.filter(r => r.remind_at && !r.cron_expr && !String(r.remind_at).startsWith(todayStr));
  const recurring = ordered.filter(r => r.cron_expr);
  const noTime = ordered.filter(r => !r.remind_at && !r.cron_expr);

  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let idx = 0;
  let msg = '📋 *Your Reminders*';
  if (today.length > 0) {
    msg += '\n\n*Today:*\n';
    for (const r of today) {
      const time = new Date(r.remind_at).toLocaleTimeString('en-US', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', hour12: true });
      const rel = relativeTime(new Date(r.remind_at));
      const noteLabel = r.notes ? `\n    📝 ${r.notes}` : '';
      msg += `  *${letters[idx++]})* ${r.text}\n    ${time} (${rel})${noteLabel}\n`;
    }
  }
  if (upcoming.length > 0) {
    msg += '\n\n*Upcoming:*\n';
    for (const r of upcoming) {
      const time = formatTime(r.remind_at, settings.timezone);
      const rel = relativeTime(new Date(r.remind_at));
      const noteLabel = r.notes ? `\n    📝 ${r.notes}` : '';
      msg += `  *${letters[idx++]})* ${r.text}\n    ${time} (${rel})${noteLabel}\n`;
    }
  }
  if (recurring.length > 0) {
    msg += '\n\n*Recurring:*\n';
    for (const r of recurring) {
      msg += `  *${letters[idx++]})* ${r.text}\n    🔁 ${r.cron_expr}\n`;
    }
  }
  if (noTime.length > 0) {
    msg += '\n\n*No time set:*\n';
    for (const r of noTime) {
      msg += `  *${letters[idx++]})* ${r.text}\n    📝 give it a time anytime\n`;
    }
  }
  if (paused.length > 0) {
    msg += `\n\n*Paused (${paused.length}):*\n`;
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

    // Explicit thought capture for a photo ("idea:/thought:/note:/#" caption) →
    // pin the caption + add the image to the idea graph.
    if (caption && imageBuffer && chatAllowed(from)) {
      const ideaCaption = extractIdeaPrefix(caption);
      if (ideaCaption !== null) {
        return sendTextMessage(from, await captureThought(from, ideaCaption, {
          mediaBuffer: imageBuffer, mediaMime: mimeType, sourceType: 'image', pinSource: 'note',
        }));
      }
    }

    // Check if user wants to analyze/read the image
    const analyzeKeywords = /analyz|summariz|read this|what is this|what does|extract|report|review|explain|translate|describe|tell me about|check this|look at/i;
    const receiptKeywords = /receipt|bill|invoice|scan receipt|log this|expense|how much/i;
    // Receipt scanning — auto-log expense from receipt photo
    if (caption && receiptKeywords.test(caption) && imageBuffer) {
      const { scanReceipt } = await import('../analyze.js');
      const receipt = await scanReceipt(imageBuffer, mimeType);
      if (receipt && receipt.amount) {
        const { addExpense } = await import('../db.js');
        await addExpense(from, receipt.amount, receipt.description, receipt.category, receipt.currency || 'JOD');
        return sendTextMessage(from, `Receipt logged: *${receipt.amount.toFixed(2)} ${receipt.currency || 'JD'}* — ${receipt.description || 'expense'} (${receipt.category || 'other'})`);
      }
      // Fallback to regular analysis if not a receipt
      const { analyzeImage } = await import('../analyze.js');
      return sendTextMessage(from, await analyzeImage(imageBuffer, mimeType, caption));
    }

    if (caption && analyzeKeywords.test(caption) && imageBuffer) {
      const { analyzeImage } = await import('../analyze.js');
      const result = await analyzeImage(imageBuffer, mimeType, caption);
      return sendTextMessage(from, result);
    }

    // No caption — analyze the image by default (if not in pending photo flow)
    if (!caption && imageBuffer && !pendingPhotos.has(from)) {
      // Ask what they want to do with it
      pendingPhotos.set(from, { buffer: imageBuffer, mimeType, text: 'Photo' });
      return sendTextMessage(from, 'Got the photo! What would you like me to do?\n\n• Set a reminder — tell me when\n• Analyze it — say "analyze" or "read this"\n• Just save it — say "save"');
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
        if (wamid) { messageReminderMap.set(wamid, id); if (messageReminderMap.size > 500) { [...messageReminderMap.keys()].slice(0, 100).forEach(k => messageReminderMap.delete(k)); } }
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

// --- Document handler ---

export async function handleDocumentMessage(from, waMediaId, caption, mimeType, filename) {
  try {
    // Download the document
    const mediaUrl = await getMediaUrl(waMediaId);
    if (!mediaUrl) return sendTextMessage(from, "Couldn't download the document.");
    const docBuffer = await downloadMedia(mediaUrl);
    if (!docBuffer) return sendTextMessage(from, "Couldn't download the document.");

    const isPdf = mimeType.includes('pdf');
    const isImage = mimeType.includes('image');

    // Check caption for reminder intent FIRST — "remind me to send this to X at Y"
    if (caption) {
      const settings = await getSettings(from);
      const activeRems = await getActiveReminders(from);
      const aiResult = await classifyIntent(caption, settings.timezone, new Date().toISOString(), activeRems, from);

      if (aiResult?.intent === 'reminder' && aiResult.reminders?.[0]?.remindAt) {
        const r = aiResult.reminders[0];
        const id = await createReminderAndSchedule(from, {
          text: r.text, remindAt: new Date(r.remindAt), cronExpr: r.cronExpr || null,
          category: r.category || null, notes: r.notes || null, priority: r.priority || 'normal',
        }, settings);
        // Save document to DB and attach to reminder
        const { saveDocument, attachMediaWithData } = await import('../db.js');
        const docId = await saveDocument(from, filename, r.text, mimeType, docBuffer);
        await attachMediaWithData(id, 'wa_image', mimeType, docBuffer);
        const timeStr = formatTime(new Date(r.remindAt).toISOString(), settings.timezone);
        const relTime = relativeTime(new Date(r.remindAt));
        return sendTextMessage(from, `✅ *${r.text}*\n${timeStr} (in ${relTime})\nDocument: ${filename}`);
      }

      if (aiResult?.intent === 'reminder' && aiResult.needsInfo) {
        // Store document as pending, ask for time
        pendingPhotos.set(from, { buffer: docBuffer, mimeType, text: caption, filename });
        return sendTextMessage(from, aiResult.needsInfo);
      }
    }

    // No reminder intent — analyze the document
    if (isPdf) {
      await sendTextMessage(from, `Analyzing *${filename}*...`);
      const { analyzePdfBuffer } = await import('../analyze.js');
      const result = await analyzePdfBuffer(docBuffer, caption || null);
      const { saveDocument } = await import('../db.js');
      await saveDocument(from, filename, result.substring(0, 200), mimeType, docBuffer);
      return sendTextMessage(from, result);
    }

    if (isImage) {
      await sendTextMessage(from, `Analyzing *${filename}*...`);
      const { analyzeImage } = await import('../analyze.js');
      const result = await analyzeImage(docBuffer, mimeType, caption || null);
      return sendTextMessage(from, result);
    }

    // Other file types — just save
    const { saveDocument } = await import('../db.js');
    await saveDocument(from, filename, caption || 'Saved document', mimeType, docBuffer);
    return sendTextMessage(from, `Saved *${filename}*. Say "show my documents" to see saved files.`);
  } catch (err) {
    console.error('[WA Document error]', err);
    return sendTextMessage(from, "Something went wrong processing the document.");
  }
}

// Helper to create + schedule a reminder and return the ID
async function createReminderAndSchedule(from, parsed, settings) {
  const id = await createReminder({
    chatId: from, text: parsed.text, remindAt: parsed.remindAt.toISOString(),
    cronExpr: parsed.cronExpr, timezone: settings.timezone, category: parsed.category,
    priority: parsed.priority, sharedWith: parsed.sharedWith, createdBy: from,
  });
  if (parsed.notes) await addNoteToReminder(id, parsed.notes);
  const reminder = await getReminder(id);
  if (new Date(reminder.remind_at).getTime() > Date.now()) {
    scheduleReminder(reminder);
  }

  // Sync to Google Calendar if connected
  try {
    const { createEvent, isConfigured } = await import('../google-calendar.js');
    if (isConfigured()) await createEvent(from, reminder);
  } catch {}

  return id;
}

// --- Voice note transcription via OpenAI Whisper ---

export async function handleAudioMessage(from, audioId, mimeType) {
  try {
    const mediaUrl = await getMediaUrl(audioId);
    if (!mediaUrl) return sendTextMessage(from, "Couldn't process that voice note.");
    const buffer = await downloadMedia(mediaUrl);
    if (!buffer) return sendTextMessage(from, "Couldn't download the voice note.");

    const { transcribeAudio } = await import('../transcribe.js');
    const transcript = await transcribeAudio(buffer, mimeType);
    if (!transcript) {
      if (!process.env.OPENAI_API_KEY) return sendTextMessage(from, 'Voice notes need an OpenAI API key to be configured.');
      return sendTextMessage(from, 'Failed to transcribe voice note. Try again or type your message.');
    }

    // Echo the transcription, then process as regular text
    await sendTextMessage(from, `🎙️ _"${transcript}"_`);
    return handleTextMessage(from, transcript);
  } catch (err) {
    console.error('[Audio] Error:', err.message);
    return sendTextMessage(from, 'Failed to process voice note.');
  }
}

// --- Reaction-based quick actions ---

export async function handleReactionMessage(from, emoji, reactedMsgId) {
  const reminderId = messageReminderMap.get(reactedMsgId);
  if (!reminderId) return; // Not a bot reminder message

  try {
    if (emoji === '👍' || emoji === '✅') {
      // Mark as done — deactivate first so a logging failure can't block completion.
      const reminder = await getReminder(reminderId);
      const { cancelReminder: cancel } = await import('./scheduler.js');
      cancel(reminderId);
      await deactivateReminder(reminderId);
      if (reminder) {
        await logCompletedReminder({ chatId: from, text: reminder.text, remindAt: reminder.remind_at });
        if (reminder.cron_expr) { await updateStreak(from, reminder.text, reminder.cron_expr); }
      }
      await sendTextMessage(from, 'Marked as done ✓');
    } else if (emoji === '⏰' || emoji === '🔁') {
      // Snooze 1 hour
      const settings = await getSettings(from);
      const newTime = new Date(Date.now() + 60 * 60 * 1000);
      await dbSnooze(reminderId, newTime.toISOString());
      await incrementSnoozeCount(reminderId);
      const { snoozeReminder: schedSnoozeWA } = await import('./scheduler.js');
      await schedSnoozeWA(reminderId, 60);
      const timeStr = newTime.toLocaleTimeString('en-US', {
        timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', hour12: true,
      });
      await sendTextMessage(from, `Snoozed 1 hour → ${timeStr}`);
    } else if (emoji === '❌') {
      // Cancel
      await deactivateReminder(reminderId);
      const { cancelReminder: cancel } = await import('./scheduler.js');
      cancel(reminderId);
      await sendTextMessage(from, 'Cancelled ✓');
    }
  } catch (err) {
    console.error('[Reaction] Error:', err.message);
  }
}

// --- Location message handling ---

export async function handleLocationMessage(from, latitude, longitude, name, address) {
  try {
    // Save user's last known location
    await setLocation(from, name || address || `${latitude.toFixed(4)},${longitude.toFixed(4)}`);

    // Check if any active reminders have location-related keywords
    const active = await getActiveReminders(from);
    const locationReminders = active.filter(r => {
      const text = (r.text + ' ' + (r.notes || '')).toLowerCase();
      return /\bat\b|\bnear\b|\bwhen i'm at\b|\bwhen i get to\b|\bstop by\b|\bpick up/i.test(text);
    });

    if (locationReminders.length > 0) {
      let msg = `📍 *Location noted.* You have ${locationReminders.length} location-tagged reminder${locationReminders.length > 1 ? 's' : ''}:\n`;
      for (const r of locationReminders.slice(0, 5)) {
        msg += `\n• ${r.text}`;
      }
      msg += '\n\nReply "done with [task]" to mark any as complete.';
      return sendTextMessage(from, msg);
    }

    return sendTextMessage(from, `📍 Location saved: ${name || address || 'your current location'}`);
  } catch (err) {
    console.error('[Location] Error:', err.message);
    return sendTextMessage(from, 'Location received.');
  }
}
