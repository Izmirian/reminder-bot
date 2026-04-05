/**
 * Express webhook server for receiving WhatsApp messages.
 * Meta sends incoming messages here via POST, and verifies via GET.
 */
import express from 'express';
import { handleTextMessage, handleButtonReply, handleImageMessage } from './handler.js';

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'selfreminder_webhook_2024';

export function createWebhookServer() {
  const app = express();
  app.use(express.json());

  // Webhook verification (Meta sends a GET to verify your endpoint)
  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('[WhatsApp] Webhook verified');
      res.status(200).send(challenge);
    } else {
      console.warn('[WhatsApp] Webhook verification failed');
      res.sendStatus(403);
    }
  });

  // Incoming messages (Meta sends a POST)
  app.post('/webhook', async (req, res) => {
    // Always respond 200 quickly to avoid retries
    res.sendStatus(200);

    try {
      const body = req.body;

      if (body.object !== 'whatsapp_business_account') return;

      const entries = body.entry || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          if (change.field !== 'messages') continue;

          const messages = change.value?.messages || [];
          for (const msg of messages) {
            const from = msg.from; // sender's phone number

            const quotedMsgId = msg.context?.id || null;

            if (msg.type === 'text') {
              await handleTextMessage(from, msg.text.body, quotedMsgId);
            } else if (msg.type === 'image') {
              const imageId = msg.image?.id;
              const caption = msg.image?.caption || '';
              const mimeType = msg.image?.mime_type || 'image/jpeg';
              if (imageId) {
                await handleImageMessage(from, imageId, caption, mimeType);
              }
            } else if (msg.type === 'interactive') {
              const buttonId = msg.interactive?.button_reply?.id;
              if (buttonId) {
                await handleButtonReply(from, buttonId);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('[WhatsApp] Error processing webhook:', err);
    }
  });

  // --- Google Calendar OAuth routes ---
  app.get('/auth/google', async (req, res) => {
    try {
      const { getAuthUrl } = await import('../google-calendar.js');
      const chatId = req.query.chat_id;
      if (!chatId) return res.status(400).send('Missing chat_id parameter');
      const url = getAuthUrl(chatId);
      if (!url) return res.status(500).send('Google Calendar not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
      res.redirect(url);
    } catch (err) {
      console.error('[GCal Auth] Error:', err);
      res.status(500).send('Failed to start Google Calendar auth');
    }
  });

  app.get('/auth/google/callback', async (req, res) => {
    try {
      const { handleCallback } = await import('../google-calendar.js');
      const code = req.query.code;
      const chatId = req.query.state;
      if (!code || !chatId) return res.status(400).send('Missing code or state');
      await handleCallback(code, chatId);
      res.send('<h2>Google Calendar connected!</h2><p>You can close this window and go back to the bot.</p>');
    } catch (err) {
      console.error('[GCal Callback] Error:', err);
      res.status(500).send('Failed to connect Google Calendar. Try again.');
    }
  });

  // Health check
  app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'WhatsApp Reminder Bot' });
  });

  return app;
}
