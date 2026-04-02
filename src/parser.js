import * as chrono from 'chrono-node';
import { parseWithAI } from './ai.js';

const DAY_MAP = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const CATEGORY_KEYWORDS = {
  health: ['meds', 'medicine', 'doctor', 'dentist', 'gym', 'workout', 'exercise', 'vitamin', 'pill', 'appointment', 'health', 'walk', 'run'],
  work: ['meeting', 'call', 'email', 'report', 'deadline', 'submit', 'timesheet', 'standup', 'review', 'deploy', 'presentation', 'work'],
  personal: ['buy', 'groceries', 'laundry', 'clean', 'cook', 'birthday', 'gift', 'pay', 'bill', 'rent'],
};

export function detectCategory(text) {
  const lower = text.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) return category;
  }
  return null;
}

/**
 * Parse a recurrence pattern like "every day", "every monday", "every week"
 * Returns a cron expression or null.
 */
function parseRecurrence(text) {
  const lower = text.toLowerCase();

  // "every day at ..."
  if (/every\s+day/i.test(lower)) return 'daily';

  // "every weekday"
  if (/every\s+weekday/i.test(lower)) return 'weekday';

  // "every <day>" e.g. "every monday", "every tue"
  const dayMatch = lower.match(/every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)/i);
  if (dayMatch) {
    const dayNum = DAY_MAP[dayMatch[1].toLowerCase()];
    return `weekly:${dayNum}`;
  }

  // "every hour"
  if (/every\s+hour/i.test(lower)) return 'hourly';

  // "every X hours"
  const hoursMatch = lower.match(/every\s+(\d+)\s+hours?/i);
  if (hoursMatch) return `every_hours:${hoursMatch[1]}`;

  // "every X minutes"
  const minsMatch = lower.match(/every\s+(\d+)\s+min(?:ute)?s?/i);
  if (minsMatch) return `every_mins:${minsMatch[1]}`;

  return null;
}

/**
 * Convert our recurrence token + a base time into a cron expression.
 */
export function toCronExpr(recurrence, hour, minute) {
  if (recurrence === 'daily') return `${minute} ${hour} * * *`;
  if (recurrence === 'weekday') return `${minute} ${hour} * * 1-5`;
  if (recurrence === 'hourly') return `${minute} * * * *`;
  if (recurrence.startsWith('weekly:')) {
    const day = recurrence.split(':')[1];
    return `${minute} ${hour} * * ${day}`;
  }
  if (recurrence.startsWith('every_hours:')) {
    const h = recurrence.split(':')[1];
    return `${minute} */${h} * * *`;
  }
  if (recurrence.startsWith('every_mins:')) {
    const m = recurrence.split(':')[1];
    return `*/${m} * * * *`;
  }
  return null;
}

/**
 * Extract the reminder text by removing time-related phrases.
 */
function extractReminderText(text) {
  let cleaned = text
    // Remove "remind me" prefix
    .replace(/^remind\s+me\s*/i, '')
    // Remove "every <day/period>" phrases
    .replace(/every\s+(?:day|weekday|hour|\d+\s+(?:hours?|min(?:ute)?s?)|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\s*/gi, '')
    // Remove "at <time>" phrases
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*/gi, '')
    // Remove "in X minutes/hours"
    .replace(/\bin\s+\d+\s+(?:min(?:ute)?s?|hours?|days?)\s*/gi, '')
    // Remove "tomorrow", "today", "next <day>"
    .replace(/\b(?:tomorrow|today|tonight)\s*/gi, '')
    .replace(/\bnext\s+\w+\s*/gi, '')
    // Remove "to" connector at the start
    .replace(/^to\s+/i, '')
    .trim();

  // Capitalize first letter
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  return cleaned || text;
}

/**
 * Parse a snooze command like "snooze 10m", "snooze 1h", "snooze 30 minutes"
 * Returns minutes to snooze or null.
 */
export function parseSnooze(text) {
  const match = text.match(/snooze\s+(\d+)\s*([mh]|min(?:ute)?s?|hours?)?/i);
  if (!match) return null;

  const num = parseInt(match[1], 10);
  const unit = (match[2] || 'm').toLowerCase();

  if (unit.startsWith('h')) return num * 60;
  return num; // default minutes
}

/**
 * Main parse function.
 * Returns { text, remindAt (Date), cronExpr (string|null), category } or null if unparseable.
 */
export function parseReminder(input, timezone = 'UTC') {
  const recurrence = parseRecurrence(input);

  // Use chrono to extract the date/time
  const refDate = new Date();
  const results = chrono.parse(input, { instant: refDate, timezone });

  if (results.length === 0 && !recurrence) return null;

  let remindAt;
  if (results.length > 0) {
    remindAt = results[0].date();
    // If parsed time is in the past (e.g., "at 3pm" but it's 5pm), push to tomorrow
    if (!recurrence && remindAt <= refDate) {
      remindAt.setDate(remindAt.getDate() + 1);
    }
  } else if (recurrence) {
    // Recurrence without specific time — default to next hour
    remindAt = new Date();
    remindAt.setMinutes(0, 0, 0);
    remindAt.setHours(remindAt.getHours() + 1);
  }

  const reminderText = extractReminderText(input);
  const category = detectCategory(reminderText);

  let cronExpr = null;
  if (recurrence) {
    const h = remindAt.getHours();
    const m = remindAt.getMinutes();
    cronExpr = toCronExpr(recurrence, h, m);
  }

  return {
    text: reminderText,
    remindAt,
    cronExpr,
    category,
  };
}

/**
 * Smart async parser — tries Claude AI first, falls back to chrono-node.
 * Returns { text, remindAt, cronExpr, category } or { needsInfo } or null.
 */
export async function parseReminderSmart(input, timezone = 'UTC') {
  // Try AI first
  try {
    const aiResult = await parseWithAI(input, timezone, new Date().toISOString());

    if (aiResult) {
      // AI needs more info from user
      if (aiResult.needsInfo) {
        return { needsInfo: aiResult.needsInfo };
      }

      // AI parsed successfully
      if (aiResult.remindAt) {
        return {
          text: aiResult.text,
          remindAt: new Date(aiResult.remindAt),
          cronExpr: aiResult.cronExpr || null,
          category: aiResult.category || detectCategory(aiResult.text),
        };
      }
    }
  } catch {
    // AI failed, fall through to chrono
  }

  // Fallback to chrono-node
  return parseReminder(input, timezone);
}
