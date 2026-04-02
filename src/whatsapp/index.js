/**
 * WhatsApp bot entry point.
 * Starts the webhook server and loads existing reminders.
 */
import 'dotenv/config';
import { createWebhookServer } from './webhook.js';
import { loadWhatsAppReminders, setupWhatsAppDigest } from './scheduler.js';

const PORT = process.env.PORT || process.env.WEBHOOK_PORT || 3000;

// Validate config
const required = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing ${key} in .env file`);
    process.exit(1);
  }
}

const app = createWebhookServer();

app.listen(PORT, () => {
  console.log(`🟢 WhatsApp bot webhook listening on port ${PORT}`);
  console.log(`   Webhook URL: http://localhost:${PORT}/webhook`);
  console.log('');
  console.log('   To receive messages, expose this with ngrok:');
  console.log(`   npx ngrok http ${PORT}`);
  console.log('   Then set the ngrok HTTPS URL as your webhook in Meta Developer portal.');
  console.log('');

  loadWhatsAppReminders();
  setupWhatsAppDigest();

  console.log('🤖 WhatsApp Reminder Bot is running!');
});
