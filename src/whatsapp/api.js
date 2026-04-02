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
  const bodyText = `⏰ *Reminder:* ${reminderText}`;
  const buttons = [
    { id: `snooze:${reminderId}:5`, title: '⏰ 5 min' },
    { id: `snooze:${reminderId}:15`, title: '⏰ 15 min' },
    { id: `done:${reminderId}`, title: '✅ Done' },
  ];

  return sendButtonMessage(to, bodyText, buttons);
}
