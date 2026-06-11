/**
 * WhatsApp webhook simulator — POSTs Meta-formatted, HMAC-signed payloads at a
 * locally running webhook server so the full inbound pipeline can be exercised
 * without a real WhatsApp number.
 *
 * Start the bot first (in another terminal):
 *   META_APP_SECRET=testsecret WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID=fake \
 *     node src/whatsapp/index.js
 *
 * Then send a message:
 *   META_APP_SECRET=testsecret node scripts/simulate-whatsapp.js "idea: graphs are cool"
 *
 * Options (env):
 *   SIM_PORT   target port (default 3000)
 *   SIM_FROM   sender number (default 962790000000)
 *
 * Pass --selftest to also verify that unsigned/forged requests are rejected and
 * duplicate message ids are deduped.
 */
import crypto from 'crypto';

const SECRET = process.env.META_APP_SECRET;
const PORT = process.env.SIM_PORT || process.env.WEBHOOK_PORT || 3000;
const FROM = process.env.SIM_FROM || '962790000000';
const URL = `http://localhost:${PORT}/webhook`;

if (!SECRET) {
  console.error('Set META_APP_SECRET to the same value the local bot was started with.');
  process.exit(1);
}

function metaEnvelope(message) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'sim-waba',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: 'sim-phone' },
          contacts: [{ profile: { name: 'Simulator' }, wa_id: FROM }],
          messages: [message],
        },
      }],
    }],
  };
}

function textMessage(body, id = `wamid.sim.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`) {
  return { from: FROM, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } };
}

function sign(rawBody, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

async function post(payload, { forgeSignature = false, omitSignature = false } = {}) {
  const raw = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (!omitSignature) headers['x-hub-signature-256'] = forgeSignature ? sign(raw, 'wrong-secret') : sign(raw);
  const res = await fetch(URL, { method: 'POST', headers, body: raw, signal: AbortSignal.timeout(15000) });
  return res.status;
}

async function main() {
  const args = process.argv.slice(2);
  const selftest = args.includes('--selftest');
  const text = args.filter(a => a !== '--selftest').join(' ') || 'idea: simulated thought from the webhook simulator';

  // 1. Legit signed message
  const msg = textMessage(text);
  const status = await post(metaEnvelope(msg));
  console.log(`[Sim] signed message -> ${status} ${status === 200 ? 'OK' : 'UNEXPECTED'} (text: "${text}")`);

  if (!selftest) return;

  // 2. Unsigned request must be rejected
  const s2 = await post(metaEnvelope(textMessage('forged: no signature')), { omitSignature: true });
  console.log(`[Sim] unsigned -> ${s2} ${s2 === 403 ? 'OK (rejected)' : 'FAIL: should be 403'}`);

  // 3. Forged signature must be rejected
  const s3 = await post(metaEnvelope(textMessage('forged: bad signature')), { forgeSignature: true });
  console.log(`[Sim] forged signature -> ${s3} ${s3 === 403 ? 'OK (rejected)' : 'FAIL: should be 403'}`);

  // 4. Duplicate message id must be accepted (200) but processed only once —
  //    verify by watching the bot's log: the second send should produce no handling.
  const dup = textMessage('idea: duplicate delivery test', 'wamid.sim.DUPLICATE');
  const s4a = await post(metaEnvelope(dup));
  const s4b = await post(metaEnvelope(dup));
  console.log(`[Sim] duplicate id -> ${s4a}/${s4b} (bot log should show it handled once)`);
}

main().catch(e => { console.error('[Sim] fatal:', e.message); process.exit(1); });
