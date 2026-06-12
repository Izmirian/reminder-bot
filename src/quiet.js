/**
 * Quiet hours — hold non-urgent reminders during a user-defined window.
 *
 * Settings carry quiet_start / quiet_end as "HH:MM" strings in the user's
 * local time. Urgent-priority reminders always break through. The window may
 * wrap past midnight (e.g. 23:00 → 08:00).
 */

function toMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Current minute-of-day in the given IANA timezone (0–1439).
function nowMinutes(timezone) {
  const hhmm = new Date().toLocaleTimeString('en-GB', {
    timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return toMinutes(hhmm) ?? 0;
}

/**
 * True if the current local time falls inside the user's quiet window.
 */
export function isQuietNow(settings) {
  if (!settings) return false;
  const start = toMinutes(settings.quiet_start);
  const end = toMinutes(settings.quiet_end);
  if (start === null || end === null || start === end) return false;
  const cur = nowMinutes(settings.timezone);
  if (start < end) return cur >= start && cur < end;   // same-day window
  return cur >= start || cur < end;                    // wraps midnight
}

/**
 * Milliseconds from now until the quiet window ends. 0 when not quiet.
 * Computed as a duration (timezone-agnostic) so no UTC conversion is needed.
 */
export function quietRemainingMs(settings) {
  if (!isQuietNow(settings)) return 0;
  const end = toMinutes(settings.quiet_end);
  const cur = nowMinutes(settings.timezone);
  let delta = end - cur;
  if (delta <= 0) delta += 1440; // wraps to tomorrow
  return delta * 60 * 1000;
}

/**
 * Parse a natural-language quiet-hours spec into { start, end } "HH:MM" or null.
 * Accepts "23:00-08:00", "11pm to 8am", "11 pm - 8 am", "off"/"disable" → null.
 */
export function parseQuietSpec(spec) {
  if (!spec || typeof spec !== 'string') return null;
  const s = spec.trim().toLowerCase();
  if (/\b(off|disable|stop|none|cancel)\b/.test(s)) return { start: null, end: null };

  // Two times separated by to / - / – / until
  const parts = s.split(/\s*(?:to|until|-|–|—)\s*/).filter(Boolean);
  if (parts.length !== 2) return null;
  const start = parseClock(parts[0]);
  const end = parseClock(parts[1]);
  if (!start || !end) return null;
  return { start, end };
}

// "11pm" | "23:00" | "8 am" | "8" → "HH:MM" (24h), or null.
function parseClock(str) {
  const t = str.trim();
  let m = t.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (m) {
    let h = Number(m[1]); const min = Number(m[2]); const mer = m[3];
    if (mer === 'pm' && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  m = t.match(/^(\d{1,2})\s*(am|pm)$/);
  if (m) {
    let h = Number(m[1]); const mer = m[2];
    if (mer === 'pm' && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
    if (h > 23) return null;
    return `${String(h).padStart(2, '0')}:00`;
  }
  m = t.match(/^(\d{1,2})$/); // bare hour, 24h
  if (m) {
    const h = Number(m[1]);
    if (h > 23) return null;
    return `${String(h).padStart(2, '0')}:00`;
  }
  return null;
}

// Pretty "23:00" → "11:00 PM" for confirmations.
export function formatClock(hhmm) {
  const mins = toMinutes(hhmm);
  if (mins === null) return hhmm;
  let h = Math.floor(mins / 60); const min = mins % 60;
  const mer = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(min).padStart(2, '0')} ${mer}`;
}
