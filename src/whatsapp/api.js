/**
 * WhatsApp Cloud API client — sends messages via Meta's Graph API.
 */

const API_VERSION = 'v22.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

/**
 * Send a plain text message to a WhatsApp number.
 */
export async function sendTextMessage(to, text) {
  const url = `${BASE_URL}/${PHONE_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`WhatsApp API error ${res.status}: ${JSON.stringify(err)}`);
  }

  return res.json();
}

/**
 * Send an interactive button message (used for snooze options).
 */
export async function sendButtonMessage(to, bodyText, buttons) {
  const url = `${BASE_URL}/${PHONE_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map((btn) => ({
          type: 'reply',
          reply: { id: btn.id, title: btn.title },
        })),
      },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`WhatsApp API error ${res.status}: ${JSON.stringify(err)}`);
  }

  return res.json();
}

/**
 * Send a reminder with snooze buttons.
 * WhatsApp allows max 3 buttons per interactive message.
 */
export async function sendReminderMessage(to, reminderText, reminderId) {
  const buttons = [
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
  const res = await fetch(`${BASE_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.url;
}

/**
 * Download media binary from WhatsApp.
 */
export async function downloadMedia(mediaUrl) {
  const res = await fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Send an image message.
 */
export async function sendImageMessage(to, imageId, caption) {
  const url = `${BASE_URL}/${PHONE_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { id: imageId, caption: caption || '' },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`WhatsApp API error ${res.status}: ${JSON.stringify(err)}`);
  }
  return res.json();
}

/**
 * Upload media to WhatsApp servers for later sending.
 */
export async function uploadMedia(buffer, mimeType) {
  if (!buffer) {
    console.error('[WA API] uploadMedia: no buffer provided');
    return null;
  }

  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const mime = mimeType || 'image/jpeg';
  const ext = mime.includes('png') ? 'png' : 'jpg';
  const url = `${BASE_URL}/${PHONE_ID}/media`;

  console.log(`[WA API] uploadMedia: ${buf.length} bytes, mime=${mime}`);

  // Build multipart manually for reliability
  const boundary = '----WhatsAppMediaBoundary' + Date.now();
  const parts = [];

  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${mime}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`);

  const header = Buffer.from(parts.join('\r\n') + '\r\n');
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, buf, footer]);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(`[WA API] uploadMedia failed ${res.status}:`, err);
    return null;
  }
  const data = await res.json();
  return data.id; // media ID for sending later
}
