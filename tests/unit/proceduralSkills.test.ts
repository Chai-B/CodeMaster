import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

process.env.CODEMASTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-proc-skills-'));

import { Skills, renderSkillMarkdown, parseSkillMarkdown } from '../../src/memory/skills.js';
import type { Task, IntermediateRepresentation } from '../../src/types/index.js';
import { now } from '../../src/util/id.js';

test('renderSkillMarkdown and parseSkillMarkdown round-trip faithfully', () => {
  const skill = {
    id: 'skill_test_1',
    name: 'migrate_database_schema',
    task_type: 'refactor',
    description: 'Procedure to safely add additive columns and update SQLite triggers.',
    steps: [
      'Inspect target schema definition in schema.ts',
      'Add nullable or defaulted columns to PRIMARY_SCHEMA and PRIMARY_MIGRATIONS',
      'Execute migration test against clean in-memory database',
    ],
    success_count: 3,
    last_verified_at: now(),
    created_at: now(),
  };

  const md = renderSkillMarkdown(skill);
  assert.ok(md.includes('name: "migrate_database_schema"'));
  assert.ok(md.includes('success_count: 3'));
  assert.ok(md.includes('## Steps'));

  const parsed = parseSkillMarkdown(md);
  assert.ok(parsed !== null);
  assert.equal(parsed.name, skill.name);
  assert.equal(parsed.task_type, skill.task_type);
  assert.equal(parsed.success_count, 3);
  assert.equal(parsed.steps?.length, 3);
  assert.equal(parsed.steps?.[0], skill.steps[0]);
});

test('Skills.recordTaskSuccess generates and stores procedural skills in DB and Markdown vault', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-skills-test-'));

  const mockTask = {
    id: 'task_abc',
    session_id: 'sess_1',
    title: 'add_user_authentication',
    description: 'Add JWT token verification to HTTP handler',
    status: 'completed',
    type: 'implement',
    input_files: [{ path: 'src/auth.ts' }],
    output_files: [],
    dependencies: [],
    blocking: [],
    reasoning_refs: [],
    decision_refs: [],
    estimated_tokens: 100,
    order: 1,
  } as unknown as Task;

  const mockIR = {
    ir_version: '1.0',
    session_id: 'sess_1',
    task_id: 'task_abc',
    produced_by: { provider_id: 'anthropic', model_id: 'claude-sonnet-4-6' },
    produced_at: now(),
    status: 'completed',
    summary: 'implemented JWT verification',
    patches: [],
    files_created: [],
    files_deleted: [],
    files_renamed: [],
    decisions: [
      {
        id: 'dec_1',
        session_id: 'sess_1',
        task_id: 'task_abc',
        produced_by: { provider_id: 'anthropic', model_id: 'claude-sonnet-4-6' },
        produced_at: now(),
        type: 'decision',
        summary: 'Use HS256 algorithm with 24h expiration for tokens',
        affected_files: [{ path: 'src/auth.ts' }],
        affected_modules: [],
        tags: [],
        permanent: true,
        wiki_keys: [],
        reference_count: 0,
        importance: 0.8,
        evidence: [],
      },
    ],
    observations: [],
    risks: [],
    assumptions: [],
    wiki_updates: [],
    wiki_reads: [],
    next_tasks: [],
    blocked_by: [],
    open_questions: [],
    overall_confidence: 0.9,
  } as unknown as IntermediateRepresentation;

  const created = Skills.recordTaskSuccess(tmpDir, mockTask, mockIR, ['src/auth.ts']);
  assert.ok(created !== null);
  assert.equal(created.name, 'add_user_authentication');
  assert.equal(created.success_count, 1);

  // Check DB retrieval
  const retrieved = Skills.get(tmpDir, 'add_user_authentication');
  assert.ok(retrieved !== null);
  assert.equal(retrieved.task_type, 'implement');
  assert.ok(retrieved.steps.some((s) => s.includes('HS256')));

  // Check Markdown vault file
  const mdPath = path.join(tmpDir, '.codemaster', 'memory', 'skills', 'add_user_authentication.md');
  assert.ok(fs.existsSync(mdPath), 'Markdown file should be written in vault');
  const mdContent = fs.readFileSync(mdPath, 'utf8');
  assert.ok(mdContent.includes('add_user_authentication'));

  // Test recording a second success increments success_count
  const second = Skills.recordTaskSuccess(tmpDir, mockTask, mockIR, ['src/auth.ts']);
  assert.equal(second?.success_count, 2);

  // Test syncFromDisk
  const synced = Skills.syncFromDisk(tmpDir);
  assert.equal(synced, 1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
