import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { Skills } from '../../src/memory/skills.js';
import { id, now } from '../../src/util/id.js';

test('Skills.findRelevant ranks matching procedural skills above unmatched ones', () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-skills-relevance-'));
  try {
  const skill1 = {
    id: id('skill'),
    name: 'database_migration_sqlite',
    task_type: 'migration',
    description: 'How to author a safe schema migration in node:sqlite',
    steps: ['Add migration column to schema.ts', 'Apply primary schema trigger', 'Verify migration tests'],
    success_count: 5,
    last_verified_at: now(),
    created_at: now(),
  };

  const skill2 = {
    id: id('skill'),
    name: 'react_component_refactor',
    task_type: 'ui',
    description: 'How to refactor React functional components with hooks',
    steps: ['Extract sub-component', 'Wrap callback in useCallback'],
    success_count: 3,
    last_verified_at: now(),
    created_at: now(),
  };

  Skills.upsert(repoPath, skill1);
  Skills.upsert(repoPath, skill2);

  const matched = Skills.findRelevant(repoPath, undefined, 'schema migration sqlite', 2);
  assert.ok(matched.length >= 1, 'Should find at least 1 relevant skill');
  assert.equal(matched[0]?.name, 'database_migration_sqlite');
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});
