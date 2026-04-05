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

  // Health check
  app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'WhatsApp Reminder Bot' });
  });

  return app;
}
