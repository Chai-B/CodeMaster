import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LongTerm } from '../../src/storage/memory.js';
import { id, now } from '../../src/util/id.js';

test('FTS5 BM25 search retrieves relevant memories and ignores irrelevant ones', () => {
  const mem1 = {
    id: id('mem'),
    namespace: 'conventions',
    key: 'testing_framework',
    value_json: JSON.stringify({ framework: 'vitest' }),
    value_markdown: 'Always prefer vitest over jest for unit testing modern TypeScript projects',
    importance: 0.9,
    confidence: 1.0,
    created_at: now(),
    updated_at: now(),
    tags: ['test', 'vitest', 'conventions'],
    permanent: true,
  };

  const mem2 = {
    id: id('mem'),
    namespace: 'architecture',
    key: 'database_engine',
    value_json: JSON.stringify({ db: 'sqlite' }),
    value_markdown: 'Use node:sqlite built-in SQLite bindings for low-overhead local state persistence',
    importance: 0.85,
    confidence: 1.0,
    created_at: now(),
    updated_at: now(),
    tags: ['database', 'sqlite', 'storage'],
    permanent: true,
  };

  LongTerm.upsert(mem1);
  LongTerm.upsert(mem2);

  // Search by keyword
  const hits1 = LongTerm.search('vitest');
  assert.ok(hits1.length > 0, 'Should find vitest memory');
  assert.equal(hits1[0]?.key, 'testing_framework');

  const hits2 = LongTerm.search('sqlite bindings');
  assert.ok(hits2.length > 0, 'Should find sqlite memory');
  assert.equal(hits2[0]?.key, 'database_engine');
});

test('Contradiction resolution marks conflicting memories as superseded', () => {
  const uniqueSuffix = id('test');
  const oldKey = `pkg_mgr_${uniqueSuffix}`;
  const memOld = {
    id: id('mem'),
    namespace: 'conventions',
    key: oldKey,
    value_json: JSON.stringify({ pm: 'npm' }),
    value_markdown: `Always use npm for dependency management ${uniqueSuffix}`,
    importance: 0.7,
    confidence: 0.9,
    created_at: now(),
    updated_at: now(),
    tags: ['npm', uniqueSuffix],
    permanent: true,
  };
  LongTerm.upsert(memOld);

  // Verify it is active
  const initial = LongTerm.search(oldKey);
  assert.equal(initial.length, 1);
  assert.equal(initial[0]?.status, 'active');

  // Insert contradicting memory with explicit contradicts_id
  const memNew = {
    id: id('mem'),
    namespace: 'conventions',
    key: `pkg_mgr_new_${uniqueSuffix}`,
    value_json: JSON.stringify({ pm: 'pnpm' }),
    value_markdown: `Switched to pnpm for dependency management; do not use npm ${uniqueSuffix}`,
    importance: 0.95,
    confidence: 1.0,
    created_at: now(),
    updated_at: now(),
    tags: ['pnpm'],
    permanent: true,
    contradicts_id: memOld.id,
  };
  LongTerm.upsert(memNew);

  // Active search should no longer return memOld
  const activeAll = LongTerm.all();
  assert.ok(activeAll.some((m) => m.id === memNew.id), 'New memory should be active');
  assert.ok(!activeAll.some((m) => m.id === memOld.id), 'Old memory should be filtered from active retrieval');

  // Full retrieval with includeSuperseded=true returns both
  const allWithSuperseded = LongTerm.all(true);
  const oldRetrieved = allWithSuperseded.find((m) => m.id === memOld.id);
  assert.equal(oldRetrieved?.status, 'superseded');
  assert.equal(oldRetrieved?.superseded_by, memNew.id);
});
