/**
 * Lightweight business signals for the daily recap — pure functions, unit-tested.
 * Deliberately quiet: each produces at most a line or two, and only when the
 * signal is strong, so the recap never turns into noise.
 */

/**
 * Categories where this week's spend is >50% above the prior 4-week weekly
 * average. `thisWeek` = category rows for the last 7 days; `last35` = rows for
 * the last 35 days (same shape: {category, currency, total}). Prior average is
 * derived as (35d - 7d) / 4. Ignores tiny amounts (< minSpend) and categories
 * with no history (avg 0 = new spending, not an anomaly).
 */
export function expenseAnomalies(thisWeek, last35, minSpend = 10) {
  const key = (r) => `${r.category || 'other'}|${r.currency || ''}`;
  const past = new Map();
  for (const r of last35 || []) past.set(key(r), Number(r.total) || 0);

  const anomalies = [];
  for (const r of thisWeek || []) {
    const week = Number(r.total) || 0;
    if (week < minSpend) continue;
    const priorTotal = (past.get(key(r)) || 0) - week;
    const weeklyAvg = priorTotal / 4;
    if (weeklyAvg <= 0) continue;
    const pct = Math.round(((week - weeklyAvg) / weeklyAvg) * 100);
    if (pct > 50) anomalies.push({ category: r.category || 'other', currency: r.currency || '', total: week, avg: weeklyAvg, pct });
  }
  return anomalies.sort((a, b) => b.pct - a.pct);
}

/** Pending follow-ups older than `minDays`, oldest first: {person, subject, days}. */
export function agingFollowups(followups, now = Date.now(), minDays = 14) {
  return (followups || [])
    .map(f => {
      const t = Date.parse(f.created_at);
      return isNaN(t) ? null : { person: f.person, subject: f.subject, days: Math.floor((now - t) / 86400000) };
    })
    .filter(f => f && f.days >= minDays)
    .sort((a, b) => b.days - a.days);
}

/** One-or-two-line recap section from both signals; '' when nothing to say. */
export function businessSignalsSection(anomalies, aging) {
  let s = '';
  if (anomalies.length) {
    const a = anomalies[0];
    s += `\n\n⚠️ *${a.category}* spending is ${a.pct}% above your usual (${a.total.toFixed(0)}${a.currency ? ' ' + a.currency : ''} this week vs ~${a.avg.toFixed(0)} avg)`;
  }
  if (aging.length) {
    const f = aging[0];
    s += `\n⏳ Still waiting on *${f.person}* (${f.subject}) — ${f.days} days`;
    if (aging.length > 1) s += ` _(+${aging.length - 1} more aging)_`;
  }
  return s;
}
