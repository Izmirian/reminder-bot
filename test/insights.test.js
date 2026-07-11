/** Business-signal math + Thoughts reply formatters — pure functions. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expenseAnomalies, agingFollowups, businessSignalsSection } from '../src/insights.js';
import { formatAskReply, formatDigestMessage } from '../src/thoughts-forward.js';

const DAY = 86400000;

test('expenseAnomalies flags >50% above the prior 4-week average', () => {
  // shopping: 300 this week; prior 4 weeks = (700-300)/4 = 100 avg -> +200%
  const week = [{ category: 'shopping', currency: 'JOD', total: 300 }];
  const last35 = [{ category: 'shopping', currency: 'JOD', total: 700 }];
  const a = expenseAnomalies(week, last35);
  assert.equal(a.length, 1);
  assert.equal(a[0].pct, 200);
  assert.equal(a[0].avg, 100);
});

test('expenseAnomalies stays quiet on normal, tiny, or no-history spend', () => {
  // normal: 100 vs avg 100
  assert.equal(expenseAnomalies(
    [{ category: 'food', total: 100 }], [{ category: 'food', total: 500 }]).length, 0);
  // tiny amounts ignored
  assert.equal(expenseAnomalies(
    [{ category: 'food', total: 5 }], [{ category: 'food', total: 6 }]).length, 0);
  // new category (no prior history) is not an anomaly
  assert.equal(expenseAnomalies(
    [{ category: 'new', total: 200 }], [{ category: 'new', total: 200 }]).length, 0);
  // empty inputs
  assert.equal(expenseAnomalies([], []).length, 0);
  assert.equal(expenseAnomalies(null, null).length, 0);
});

test('agingFollowups returns only >=14d, oldest first', () => {
  const now = Date.now();
  const rows = [
    { person: 'Sara', subject: 'invoice', created_at: new Date(now - 21 * DAY).toISOString() },
    { person: 'Omar', subject: 'quote', created_at: new Date(now - 30 * DAY).toISOString() },
    { person: 'New', subject: 'x', created_at: new Date(now - 2 * DAY).toISOString() },
    { person: 'Bad', subject: 'y', created_at: 'not-a-date' },
  ];
  const aging = agingFollowups(rows, now);
  assert.deepEqual(aging.map(f => f.person), ['Omar', 'Sara']);
  assert.equal(aging[0].days, 30);
});

test('businessSignalsSection formats one line per signal, empty when quiet', () => {
  assert.equal(businessSignalsSection([], []), '');
  const s = businessSignalsSection(
    [{ category: 'shopping', currency: 'JOD', total: 300, avg: 100, pct: 200 }],
    [{ person: 'Omar', subject: 'quote', days: 30 }, { person: 'Sara', subject: 'invoice', days: 21 }],
  );
  assert.match(s, /shopping.*200% above/);
  assert.match(s, /Omar.*30 days/);
  assert.match(s, /\+1 more aging/);
});

test('formatAskReply: grounded answer with dated sources', () => {
  const r = formatAskReply({
    ok: true,
    answer: 'You had two giveaway ideas focused on repeat customers [1][2].',
    sources: [
      { id: 1, content: 'giveaways should target repeat customers', createdAt: '2026-06-01T10:00:00Z' },
      { id: 2, content: 'free polishing with every giveaway entry', createdAt: '2026-06-20T10:00:00Z' },
    ],
  }, 'giveaways');
  assert.match(r, /^🧠 You had two giveaway ideas/);
  assert.match(r, /From your notes:/);
  assert.match(r, /repeat customers.*2026-06-01/s);
});

test('formatAskReply: degraded (sources only) and honest-miss shapes', () => {
  const degraded = formatAskReply({ ok: true, answer: null, sources: [{ id: 1, content: 'note', createdAt: null }] }, 'q');
  assert.match(degraded, /what your notes say/);
  const miss = formatAskReply({ ok: true, answer: null, sources: [] }, 'q');
  assert.match(miss, /Nothing in your notes/);
  const down = formatAskReply(null, 'q');
  assert.match(down, /unreachable/);
});

test('formatDigestMessage: full digest and quiet-skip', () => {
  assert.equal(formatDigestMessage(null), null);
  assert.equal(formatDigestMessage({ ok: true, ideaCount: 2 }), null, 'too small -> skip');
  const msg = formatDigestMessage({
    ok: true, ideaCount: 40, newThisWeek: 5,
    hottestCluster: { label: 'Diamond app', summary: 'sorting and inventory ideas', size: 8, heat: 0.9 },
    resurface: { content: 'an old spark', created_at: '2026-03-01T00:00:00Z' },
    bridge: { relation: 'builds-on', reason: 'adds pricing', src_content: 'idea A', dst_content: 'idea B' },
  });
  assert.match(msg, /5 new thoughts/);
  assert.match(msg, /Hottest theme:.*Diamond app/);
  assert.match(msg, /idea A.*builds-on.*idea B/);
  assert.match(msg, /Worth revisiting:.*an old spark.*2026-03-01/s);
});

test('thoughtReply echoes the related older idea on capture', async () => {
  const { thoughtReply } = await import('../src/thoughts-forward.js');
  const r = thoughtReply({
    pinned: true, graphConfigured: true,
    graph: { ok: true, linkedCount: 1, topNeighbor: { content: 'old spark', createdAt: '2026-05-03T00:00:00Z' } },
  });
  assert.match(r, /relates to: "old spark" \(2026-05-03\)/);
  // no neighbor -> no echo line
  assert.ok(!thoughtReply({ pinned: true, graphConfigured: true, graph: { ok: true, linkedCount: 0 } }).includes('relates to'));
});
