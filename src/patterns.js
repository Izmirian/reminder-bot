/**
 * Recurring pattern detection — detects when a user sets similar reminders repeatedly.
 */
import { getCompletedReminders } from './db.js';

// Track recent suggestions to avoid nagging
const recentSuggestions = new Map(); // chatId -> Map<patternKey, timestamp>

/**
 * Jaccard similarity on word sets.
 */
function textSimilarity(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Cluster completed reminders by text similarity.
 */
function clusterByText(reminders, threshold = 0.5) {
  const clusters = [];

  for (const r of reminders) {
    let placed = false;
    for (const cluster of clusters) {
      if (textSimilarity(cluster[0].text, r.text) >= threshold) {
        cluster.push(r);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push([r]);
    }
  }

  return clusters;
}

/**
 * Check if a pattern has already been suggested recently.
 */
function wasSuggestedRecently(chatId, patternKey) {
  const chatSuggestions = recentSuggestions.get(chatId);
  if (!chatSuggestions) return false;

  const lastSuggested = chatSuggestions.get(patternKey);
  if (!lastSuggested) return false;

  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  return Date.now() - lastSuggested < sevenDays;
}

function markSuggested(chatId, patternKey) {
  if (!recentSuggestions.has(chatId)) {
    recentSuggestions.set(chatId, new Map());
  }
  recentSuggestions.get(chatId).set(patternKey, Date.now());
}

/**
 * Detect recurring patterns from completed reminders.
 * Returns array of { text, dayOfWeek, hour, minute, suggestedCron } or empty array.
 */
export function detectRecurringPattern(chatId) {
  const completed = getCompletedReminders(chatId, 28);
  if (completed.length < 3) return [];

  const clusters = clusterByText(completed);
  const suggestions = [];

  for (const cluster of clusters) {
    if (cluster.length < 3) continue;

    // Check if entries span 3+ distinct weeks
    const weeks = new Set(cluster.map(r => {
      const d = new Date(r.completed_at);
      const yearWeek = `${d.getFullYear()}-W${Math.ceil((d.getDate() + new Date(d.getFullYear(), d.getMonth(), 1).getDay()) / 7)}`;
      return yearWeek;
    }));

    if (weeks.size < 3) continue;

    // Check if majority share the same day of week
    const dayCounts = {};
    for (const r of cluster) {
      dayCounts[r.day_of_week] = (dayCounts[r.day_of_week] || 0) + 1;
    }
    const topDay = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0];
    if (topDay[1] < cluster.length * 0.6) continue;

    // Check if majority are within 2 hours of each other
    const hours = cluster.map(r => r.hour);
    const avgHour = Math.round(hours.reduce((a, b) => a + b, 0) / hours.length);
    const withinRange = hours.filter(h => Math.abs(h - avgHour) <= 2).length;
    if (withinRange < cluster.length * 0.6) continue;

    const dayOfWeek = parseInt(topDay[0], 10);
    const minute = Math.round(cluster.map(r => r.minute).reduce((a, b) => a + b, 0) / cluster.length);
    const patternKey = `${cluster[0].text.toLowerCase().slice(0, 20)}-${dayOfWeek}-${avgHour}`;

    if (wasSuggestedRecently(chatId, patternKey)) continue;

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    suggestions.push({
      text: cluster[0].text,
      dayOfWeek,
      dayName: dayNames[dayOfWeek],
      hour: avgHour,
      minute,
      suggestedCron: `${minute} ${avgHour} * * ${dayOfWeek}`,
      patternKey,
    });

    markSuggested(chatId, patternKey);
  }

  return suggestions;
}
