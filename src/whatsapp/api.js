/**
 * WhatsApp Cloud API client — sends messages via Meta's Graph API.
 */
import { CONFIG } from '../config.js';

const API_VERSION = 'v22.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

/**
 * Fetch with retry — exponential backoff for transient failures (429, 5xx, timeout).
 */
async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeout || CONFIG.FETCH_TIMEOUT) });
      if (res.ok || res.status < 429 || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res;
      // Retryable: 429, 500, 502, 503, 504
      if (i < retries - 1) {
        const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
        console.warn(`[WA API] ${res.status} — retrying in ${delay}ms (attempt ${i + 2}/${retries})`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        return res; // Final attempt, return whatever we got
      }
    } catch (err) {
      if (i < retries - 1 && (err.name === 'TimeoutError' || err.name === 'AbortError' || err.code === 'ECONNRESET')) {
        const delay = Math.pow(2, i) * 1000;
        console.warn(`[WA API] ${err.name} — retrying in ${delay}ms (attempt ${i + 2}/${retries})`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Mark a message as read (shows blue ticks).
 */
export async function markAsRead(messageId) {
  const url = `${BASE_URL}/${PHONE_ID}/messages`;
  try {
    await fetchWithRetry(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
    }, 1); // No retry for read receipts
  } catch (e) { console.error('[WA API] markAsRead failed:', e.message); }
}

/**
 * Send a plain text message.
 */
export async function sendTextMessage(to, text) {
  const url = `${BASE_URL}/${PHONE_ID}/messages`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`WhatsApp API error ${res.status}: ${JSON.stringify(err)}`);
  }
  return res.json();
}

/**
 * Send an interactive button message.
 */
export async function sendButtonMessage(to, bodyText, buttons) {
  const url = `${BASE_URL}/${PHONE_ID}/messages`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'button', body: { text: bodyText },
        action: { buttons: buttons.map(btn => ({ type: 'reply', reply: { id: btn.id, title: btn.title } })) },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`WhatsApp API error ${res.status}: ${JSON.stringify(err)}`);
  }
  return res.json();
}

/**
 * Send a reminder with snooze buttons (smart follow-up after 3+ snoozes).
 */
export async function sendReminderMessage(to, reminderText, reminderId, snoozeCount = 0) {
  const buttons = snoozeCount >= 3
    ? [
        { id: `reschedule_tomorrow:${reminderId}`, title: 'Tomorrow 9am' },
        { id: `drop:${reminderId}`, title: 'Drop it' },
        { id: `done:${reminderId}`, title: 'Done' },
      ]
    : [
        { id: `snooze:${reminderId}:15`, title: '15 min' },
        { id: `snooze:${reminderId}:60`, title: '1 hour' },
        { id: `done:${reminderId}`, title: 'Done' },
      ];
  return sendButtonMessage(to, reminderText, buttons);
}

/**
 * Get the download URL for a WhatsApp media ID.
 */
export async function getMediaUrl(mediaId) {
  const res = await fetchWithRetry(`${BASE_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  }, 2);
  if (!res.ok) return null;
  const data = await res.json();
  return data.url;
}

/**
 * Download media binary from WhatsApp (capped at 20MB).
 */
export async function downloadMedia(mediaUrl) {
  const res = await fetchWithRetry(mediaUrl, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  }, 2);
  if (!res.ok) return null;

  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
  if (contentLength > CONFIG.MAX_DOWNLOAD_SIZE) {
    console.warn(`[WA API] File too large: ${contentLength} bytes (max ${CONFIG.MAX_DOWNLOAD_SIZE})`);
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Send an image message.
 */
export async function sendImageMessage(to, imageId, caption) {
  const url = `${BASE_URL}/${PHONE_ID}/messages`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'image', image: { id: imageId, caption: caption || '' } }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`WhatsApp API error ${res.status}: ${JSON.stringify(err)}`);
  }
  return res.json();
}

/**
 * Upload media to WhatsApp servers.
 */
export async function uploadMedia(buffer, mimeType) {
  if (!buffer) { console.error('[WA API] uploadMedia: no buffer'); return null; }

  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const mime = mimeType || 'image/jpeg';
  const ext = mime.includes('png') ? 'png' : 'jpg';
  const url = `${BASE_URL}/${PHONE_ID}/media`;

  const boundary = '----WhatsAppMediaBoundary' + Date.now();
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${mime}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`);

  const header = Buffer.from(parts.join('\r\n') + '\r\n');
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, buf, footer]);

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
    timeout: CONFIG.UPLOAD_TIMEOUT,
  }, 2);

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(`[WA API] uploadMedia failed ${res.status}:`, err);
    return null;
  }
  const data = await res.json();
  return data.id;
}
