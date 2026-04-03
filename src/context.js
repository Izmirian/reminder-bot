/**
 * Context-aware message builder — clean, minimal reminder messages.
 */

export function buildContextualMessage(reminderText, category, timezone) {
  let hour;
  try {
    const timeStr = new Date().toLocaleString('en-US', {
      timeZone: timezone, hour: 'numeric', hour12: false,
    });
    hour = parseInt(timeStr, 10);
  } catch {
    hour = new Date().getHours();
  }

  // Simple time-of-day prefix
  let prefix;
  if (hour >= 6 && hour <= 11) prefix = 'Reminder';
  else if (hour >= 12 && hour <= 17) prefix = 'Reminder';
  else if (hour >= 18 && hour <= 21) prefix = 'Reminder';
  else prefix = 'Reminder';

  return `⏰ ${prefix}: *${reminderText}*`;
}
