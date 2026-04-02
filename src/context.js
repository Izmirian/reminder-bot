/**
 * Context-aware message builder — adds time-of-day greetings and day context.
 */

const timeGreetings = [
  { start: 6, end: 11, greeting: 'Good morning!', emoji: '☀️' },
  { start: 12, end: 17, greeting: 'Afternoon reminder:', emoji: '🌤️' },
  { start: 18, end: 21, greeting: 'Evening reminder:', emoji: '🌆' },
  // 22-5 handled as default
];

const dayMessages = {
  0: '🌅 Relaxing Sunday —',
  1: '💪 Monday —',
  5: '🎉 Happy Friday!',
  6: '🌅 Weekend vibes —',
};

const catEmojis = { health: '🏥', work: '💼', personal: '🏠' };

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

  let dayOfWeek;
  try {
    const dayStr = new Date().toLocaleString('en-US', {
      timeZone: timezone, weekday: 'long',
    });
    const dayMap = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
    dayOfWeek = dayMap[dayStr] ?? new Date().getDay();
  } catch {
    dayOfWeek = new Date().getDay();
  }

  // Time greeting
  const match = timeGreetings.find(t => hour >= t.start && hour <= t.end);
  const greeting = match ? `${match.emoji} ${match.greeting}` : '🌙 Before bed:';

  // Day context
  const dayMsg = dayMessages[dayOfWeek] || '';

  // Category emoji
  const catEmoji = catEmojis[category] || '';

  // Build message
  const parts = [];
  if (dayMsg) parts.push(dayMsg);
  parts.push(greeting);
  parts.push('');
  parts.push(`${catEmoji} *${reminderText}*`);

  return parts.join('\n').trim();
}
