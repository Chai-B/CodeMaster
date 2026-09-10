import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LongTerm, calibratedScore } from '../../src/storage/memory.js';
import { id, now } from '../../src/util/id.js';

test('calibratedScore calculates importance, confidence, and decay', () => {
  const permMem = {
    id: id('mem'),
    namespace: 'conventions',
    key: 'perm_key',
    value_json: '{}',
    importance: 0.8,
    confidence: 0.9,
    created_at: new Date(Date.now() - 30 * 86400000).toISOString(),
    updated_at: now(),
    tags: [],
    permanent: true,
  };
  const decayingMem = {
    ...permMem,
    id: id('mem'),
    key: 'decaying_key',
    permanent: false,
  };

  const permScore = calibratedScore(permMem);
  const decayScore = calibratedScore(decayingMem);

  assert.ok(Math.abs(permScore - 0.72) < 0.001, 'Permanent memory should not decay');
  assert.ok(decayScore < permScore, 'Non-permanent memory should decay over 30 days');
});

test('hybridSearch returns ranked results using RRF and calibrated scoring', async () => {
  const uniqueKey = `hybrid_${id('test')}`;
  const uniqueTerm = `mvc_${id('tok')}`;
  const mem = {
    id: id('mem'),
    namespace: 'conventions',
    key: uniqueKey,
    value_json: JSON.stringify({ pattern: 'mvc' }),
    value_markdown: `Model View Controller architectural pattern ${uniqueTerm} for service separation`,
    importance: 0.95,
    confidence: 1.0,
    created_at: now(),
    updated_at: now(),
    tags: ['mvc', 'architecture', uniqueTerm],
    permanent: true,
  };

  LongTerm.upsert(mem);

  const results = await LongTerm.hybridSearch(uniqueTerm, 5);
  assert.ok(results.length > 0, 'Should find candidate via hybrid search');
  assert.equal(results[0]?.key, uniqueKey);
});
