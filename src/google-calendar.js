/**
 * Google Calendar integration — OAuth2 flow, event CRUD, two-way sync.
 */
import { google } from 'googleapis';
import {
  getGoogleTokens, setGoogleTokens, setGoogleEventId,
  getUsersWithGoogleTokens, getActiveReminders, createReminder, getSettings,
} from './db.js';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://web-production-214e2.up.railway.app/auth/google/callback';

function getOAuth2Client(tokens) {
  const client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  if (tokens) client.setCredentials(tokens);

  // Auto-refresh tokens
  client.on('tokens', async (newTokens) => {
    if (newTokens.refresh_token) {
      // Store updated tokens — but we need chatId context
      // This is handled at the caller level
    }
  });

  return client;
}

/**
 * Get the Google OAuth2 consent URL.
 */
export function getAuthUrl(chatId) {
  if (!CLIENT_ID || !CLIENT_SECRET) return null;
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: chatId,
  });
}

/**
 * Exchange auth code for tokens and store them.
 */
export async function handleCallback(code, chatId) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  await setGoogleTokens(chatId, tokens);
  return tokens;
}

/**
 * Create a Google Calendar event from a reminder.
 */
export async function createEvent(chatId, reminder) {
  const tokens = await getGoogleTokens(chatId);
  if (!tokens) return null;

  const client = getOAuth2Client(tokens);
  const calendar = google.calendar({ version: 'v3', auth: client });

  const startTime = new Date(reminder.remind_at);
  const endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // 30 min duration

  try {
    const event = await calendar.events.insert({
      calendarId: 'primary',
      resource: {
        summary: reminder.text,
        description: reminder.notes || '',
        start: { dateTime: startTime.toISOString() },
        end: { dateTime: endTime.toISOString() },
        reminders: { useDefault: false, overrides: [] }, // Bot handles reminders
      },
    });

    if (event.data.id) {
      await setGoogleEventId(reminder.id, event.data.id);
    }

    // Refresh tokens if needed
    const currentTokens = client.credentials;
    if (currentTokens.access_token !== tokens.access_token) {
      await setGoogleTokens(chatId, currentTokens);
    }

    return event.data.id;
  } catch (err) {
    console.error(`[GCal] Failed to create event for reminder ${reminder.id}:`, err.message);
    // If token expired, clear tokens
    if (err.code === 401) await setGoogleTokens(chatId, null);
    return null;
  }
}

/**
 * Delete a Google Calendar event.
 */
export async function deleteEvent(chatId, eventId) {
  if (!eventId) return;
  const tokens = await getGoogleTokens(chatId);
  if (!tokens) return;

  const client = getOAuth2Client(tokens);
  const calendar = google.calendar({ version: 'v3', auth: client });

  try {
    await calendar.events.delete({ calendarId: 'primary', eventId });
  } catch (err) {
    console.error(`[GCal] Failed to delete event ${eventId}:`, err.message);
  }
}

/**
 * Update a Google Calendar event time.
 */
export async function updateEventTime(chatId, eventId, newTime) {
  if (!eventId) return;
  const tokens = await getGoogleTokens(chatId);
  if (!tokens) return;

  const client = getOAuth2Client(tokens);
  const calendar = google.calendar({ version: 'v3', auth: client });

  const startTime = new Date(newTime);
  const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);

  try {
    await calendar.events.patch({
      calendarId: 'primary',
      eventId,
      resource: {
        start: { dateTime: startTime.toISOString() },
        end: { dateTime: endTime.toISOString() },
      },
    });
  } catch (err) {
    console.error(`[GCal] Failed to update event ${eventId}:`, err.message);
  }
}

/**
 * Sync events FROM Google Calendar TO reminders.
 * Fetches upcoming events (next 7 days) and creates reminders for new ones.
 */
export async function syncFromCalendar(chatId, scheduleReminderFn) {
  const tokens = await getGoogleTokens(chatId);
  if (!tokens) return [];

  const client = getOAuth2Client(tokens);
  const calendar = google.calendar({ version: 'v3', auth: client });

  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  try {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: weekFromNow.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });

    const events = response.data.items || [];
    const activeReminders = await getActiveReminders(chatId);
    const existingEventIds = new Set(activeReminders.map(r => r.google_event_id).filter(Boolean));
    const created = [];

    for (const event of events) {
      if (!event.id || existingEventIds.has(event.id)) continue;
      if (!event.start?.dateTime) continue; // Skip all-day events

      const eventStart = new Date(event.start.dateTime);
      // Remind 15 minutes before
      const remindAt = new Date(eventStart.getTime() - 15 * 60 * 1000);
      if (remindAt <= now) continue; // Already past

      const settings = await getSettings(chatId);
      const id = await createReminder({
        chatId,
        text: event.summary || 'Calendar event',
        remindAt: remindAt.toISOString(),
        timezone: settings.timezone,
      });
      await setGoogleEventId(id, event.id);

      // Schedule the reminder
      if (scheduleReminderFn) {
        const { getReminder } = await import('./db.js');
        const reminder = await getReminder(id);
        scheduleReminderFn(reminder);
      }

      created.push(event.summary);
    }

    // Refresh tokens if needed
    const currentTokens = client.credentials;
    if (currentTokens.access_token !== tokens.access_token) {
      await setGoogleTokens(chatId, currentTokens);
    }

    return created;
  } catch (err) {
    console.error(`[GCal] Sync failed for ${chatId}:`, err.message);
    if (err.code === 401) await setGoogleTokens(chatId, null);
    return [];
  }
}

/**
 * Check if Google Calendar integration is configured.
 */
export function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}
