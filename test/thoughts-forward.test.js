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
