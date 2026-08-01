/**
 * Voyage embeddings client tests.
 * The live-API test only runs when VOYAGE_API_KEY is set (mirrors the
 * DATABASE_URL-gated pattern in test/db.test.js) — npm test stays fast/free
 * by default, with a real integration check available when the key is present.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedText } from '../src/embeddings.js';

const hasVoyageKey = !!process.env.VOYAGE_API_KEY;

test('embedText returns null when VOYAGE_API_KEY is unset', async () => {
  const saved = process.env.VOYAGE_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  try {
    assert.equal(await embedText('hello world'), null);
  } finally {
    if (saved !== undefined) process.env.VOYAGE_API_KEY = saved;
  }
});

test('embedText returns null for empty text (fast path, no network)', async () => {
  assert.equal(await embedText(''), null);
});

test('embedText returns a 512-dim vector for real text (live Voyage call)', { skip: !hasVoyageKey }, async () => {
  const result = await embedText('The quick brown fox jumps over the lazy dog.');
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 512);
  assert.equal(typeof result[0], 'number');
});
