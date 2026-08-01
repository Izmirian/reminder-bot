/**
 * Tests for the Thoughts capture helpers. These are pure functions, but the
 * allowlist is read from env at import time, so each scenario imports the module
 * fresh with a distinct query-string cache-buster after setting env.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function freshModule(env) {
  for (const k of ['THOUGHTS_INGEST_URL', 'THOUGHTS_INGEST_SECRET', 'THOUGHTS_ALLOWED_CHATS', 'WHATSAPP_TO_NUMBER']) delete process.env[k];
  Object.assign(process.env, env);
  return import(`../src/thoughts-forward.js?cb=${Math.random()}`);
}

test('extractIdeaPrefix recognises idea:/thought:/note:/# and strips the prefix', async () => {
  const { extractIdeaPrefix } = await freshModule({});
  assert.equal(extractIdeaPrefix('idea: graphs are cool'), 'graphs are cool');
  assert.equal(extractIdeaPrefix('Thought:  scarcity drives decisions'), 'scarcity drives decisions');
  assert.equal(extractIdeaPrefix('note: cheap flights are Tuesdays'), 'cheap flights are Tuesdays');
  assert.equal(extractIdeaPrefix('#quick spark'), 'quick spark');
  assert.equal(extractIdeaPrefix('idea:multi\nline'), 'multi\nline');
});

test('extractIdeaPrefix leaves non-prefixed messages alone', async () => {
  const { extractIdeaPrefix } = await freshModule({});
  assert.equal(extractIdeaPrefix('remind me at 5pm'), null);
  assert.equal(extractIdeaPrefix('notes app is great'), null, 'only a "note:" prefix counts');
  assert.equal(extractIdeaPrefix('#'), null);
  assert.equal(extractIdeaPrefix(''), null);
});

test('thoughtsEnabled reflects whether URL + secret are configured', async () => {
  let m = await freshModule({});
  assert.equal(m.thoughtsEnabled(), false);
  m = await freshModule({ THOUGHTS_INGEST_URL: 'http://x', THOUGHTS_INGEST_SECRET: 's' });
  assert.equal(m.thoughtsEnabled(), true);
});

test('chatAllowed defaults to the owner number and rejects strangers', async () => {
  const { chatAllowed } = await freshModule({ WHATSAPP_TO_NUMBER: '962790000000' });
  assert.equal(chatAllowed('962790000000'), true);
  assert.equal(chatAllowed('+962 79 000 0000'), true, 'format-insensitive');
  assert.equal(chatAllowed('15551234567'), false, 'stranger blocked');
});

test('chatAllowed honours an explicit comma-separated allowlist', async () => {
  const { chatAllowed } = await freshModule({ THOUGHTS_ALLOWED_CHATS: '111, 222' });
  assert.equal(chatAllowed('111'), true);
  assert.equal(chatAllowed('222'), true);
  assert.equal(chatAllowed('333'), false);
});

test('chatAllowed is open when no allowlist and no owner number is set', async () => {
  const { chatAllowed } = await freshModule({});
  assert.equal(chatAllowed('any-number'), true);
});

test('thoughtReply is unmistakable and reflects pin + graph outcome', async () => {
  const { thoughtReply } = await freshModule({});
  // pinned + in graph
  assert.match(thoughtReply({ pinned: true, graph: { ok: true, linkedCount: 0 }, graphConfigured: true }), /Pinned & added to your idea graph/);
  assert.match(thoughtReply({ pinned: true, graph: { ok: true, linkedCount: 2 }, graphConfigured: true }), /2 related thoughts/);
  // pinned but graph configured-yet-unreachable: still confirms the pin (nothing lost)
  assert.match(thoughtReply({ pinned: true, graph: null, graphConfigured: true }), /Pinned\b.*catch up/);
  // pinned, graph not configured at all
  assert.match(thoughtReply({ pinned: true, graph: null, graphConfigured: false }), /Pinned to your thoughts/);
  // total failure surfaces a resend prompt, never a silent success
  assert.match(thoughtReply({ pinned: false, graph: null, graphConfigured: false }), /Couldn't save/);
});

test('getForwardStats starts null and records outcomes via forwardToThoughts', async () => {
  // Point at a dead local port -> terminal network failure -> error recorded.
  const m = await freshModule({ THOUGHTS_INGEST_URL: 'http://127.0.0.1:1', THOUGHTS_INGEST_SECRET: 's' });
  const before = m.getForwardStats();
  assert.equal(before.lastOkAt, null);
  assert.equal(before.lastErrorAt, null);
  await m.forwardToThoughts({ chatId: 'x', text: 'hi' }, 1); // 1 attempt, no retry delay
  const after = m.getForwardStats();
  assert.equal(after.lastOkAt, null);
  assert.ok(after.lastErrorAt, 'error timestamp recorded');
  assert.equal(after.lastErrorCode, 0, '0 = network failure');
});

test('GET /health reports db + thoughts checks without leaking secrets', async () => {
  // Boot the real webhook server in a child process (importing it in-process
  // drags in scheduler timers that would keep the test runner alive forever).
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { createWebhookServer } = await import(new URL('../src/whatsapp/webhook.js', 'file://' + ${JSON.stringify(import.meta.url.replace('file://', ''))}).href);
    const server = createWebhookServer().listen(0, () => console.log('PORT=' + server.address().port));
  `], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, THOUGHTS_INGEST_URL: '', THOUGHTS_INGEST_SECRET: '', DATABASE_URL: '' } });

  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server boot timeout')), 20000);
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/PORT=(\d+)/);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
      child.on('exit', () => reject(new Error('server exited early')));
    });

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(['ok', 'degraded'].includes(body.status));
    assert.equal(typeof body.uptime, 'number');
    assert.ok('ok' in body.checks.db, 'db check present');
    assert.equal(body.checks.thoughts.configured, false, 'unconfigured in test env');
    assert.ok(!/secret|token|password/i.test(JSON.stringify(body)), 'no secret-ish keys in payload');
    // legacy root route unchanged
    const legacy = await (await fetch(`http://127.0.0.1:${port}/`)).json();
    assert.equal(legacy.service, 'WhatsApp Reminder Bot');
  } finally {
    child.kill('SIGKILL');
  }
});
