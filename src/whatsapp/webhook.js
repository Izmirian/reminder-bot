/**
 * Express webhook server for receiving WhatsApp messages.
 * Meta sends incoming messages here via POST, and verifies via GET.
 */
import express from 'express';
import crypto from 'crypto';
import { handleTextMessage, handleButtonReply, handleImageMessage, handleDocumentMessage } from './handler.js';
import { markAsRead } from './api.js';

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'selfreminder_webhook_2024';

export function createWebhookServer() {
  const app = express();
  app.use(express.json({
    limit: '1mb',
    verify: (req, res, buf) => { req.rawBody = buf; },
  }));

  // Message deduplication — prevent double-processing from Meta retries
  const processedMessages = new Set();
  function isDuplicate(msgId) {
    if (!msgId) return false;
    if (processedMessages.has(msgId)) return true;
    processedMessages.add(msgId);
    if (processedMessages.size > 10000) {
      const first = processedMessages.values().next().value;
      processedMessages.delete(first);
    }
    return false;
  }

  // Verify Meta webhook signature
  function verifySignature(req) {
    const signature = req.headers['x-hub-signature-256'];
    if (!process.env.META_APP_SECRET) { console.warn('[Webhook] META_APP_SECRET not set — rejecting request'); return false; }
    if (!signature) return false;
    try {
      const expected = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET)
        .update(req.rawBody)
        .digest('hex');
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch { return false; }
  }

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
    // Verify request is from Meta
    if (!verifySignature(req)) {
      console.warn('[Webhook] Invalid signature — rejecting');
      return res.sendStatus(403);
    }

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

            // Deduplicate — skip if already processed (Meta retry)
            if (isDuplicate(msg.id)) continue;

            // Mark as read immediately (shows blue ticks)
            if (msg.id) markAsRead(msg.id);

            if (msg.type === 'text') {
              await handleTextMessage(from, msg.text.body, quotedMsgId);
            } else if (msg.type === 'image') {
              const imageId = msg.image?.id;
              const caption = msg.image?.caption || '';
              const mimeType = msg.image?.mime_type || 'image/jpeg';
              if (imageId) {
                await handleImageMessage(from, imageId, caption, mimeType);
              }
            } else if (msg.type === 'document') {
              const docId = msg.document?.id;
              const caption = msg.document?.caption || '';
              const mimeType = msg.document?.mime_type || 'application/pdf';
              const filename = msg.document?.filename || 'document';
              if (docId) {
                await handleDocumentMessage(from, docId, caption, mimeType, filename);
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
      const { handleCallback, resolveAuthNonce } = await import('../google-calendar.js');
      const code = req.query.code;
      const nonce = req.query.state;
      if (!code || !nonce) return res.status(400).send('Missing code or state');
      // Resolve nonce to chatId — prevents state-forgery attacks
      const chatId = resolveAuthNonce(nonce);
      if (!chatId) return res.status(403).send('Invalid or expired auth session. Please start the connection again from the bot.');
      await handleCallback(code, chatId);
      res.send('<h2>Google Calendar connected!</h2><p>You can close this window and go back to the bot.</p>');
    } catch (err) {
      console.error('[GCal Callback] Error:', err);
      res.status(500).send('Failed to connect Google Calendar. Try again.');
    }
  });

  // --- GitHub Webhook — disabled (alerts removed, endpoint kept as silent no-op) ---
  app.post('/github-webhook', (_req, res) => res.sendStatus(200));

  // Health check
  app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'WhatsApp Reminder Bot', uptime: Math.floor(process.uptime()) });
  });

  return app;
}
