import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recencyDecay, effectiveImportance } from '../../src/memory/lifecycle.js';

test('recency decay is 1 at creation and decreases over time', () => {
  const nowMs = Date.parse('2026-01-31T00:00:00Z');
  assert.ok(Math.abs(recencyDecay('2026-01-31T00:00:00Z', nowMs) - 1) < 1e-6);
  const tenDays = recencyDecay('2026-01-21T00:00:00Z', nowMs);
  assert.ok(tenDays < 1 && tenDays > 0);
  // exp(-0.05*10) ≈ 0.6065
  assert.ok(Math.abs(tenDays - Math.exp(-0.5)) < 1e-6);
});

test('permanent memories never decay', () => {
  const eff = effectiveImportance({ importance: 0.1, confidence: 0.1, reference_count: 0, created_at: '2000-01-01T00:00:00Z', permanent: true });
  assert.equal(eff, Infinity);
});

test('references increase effective importance', () => {
  const base = { importance: 0.8, confidence: 0.9, created_at: new Date().toISOString(), permanent: false };
  const noRefs = effectiveImportance({ ...base, reference_count: 0 });
  const manyRefs = effectiveImportance({ ...base, reference_count: 10 });
  assert.ok(manyRefs > noRefs);
});
