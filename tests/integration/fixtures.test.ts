// Repository fixture tests (spec §24.3) — known expected index state for
// small-python, legacy-codebase (circular imports), and medium-monorepo.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { StaticAnalysisAPI } from '../../src/analysis/api.js';
import { selectFiles } from '../../src/context/fileSelector.js';
import type { Task } from '../../src/types/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const dirs = ['small-python', 'legacy-codebase', 'medium-monorepo', 'react-tsx'];

before(async () => {
  for (const d of dirs) await new StaticAnalysisAPI(path.join(FIXTURES, d)).reindex({ embed: false });
});
after(() => {
  for (const d of dirs) fs.rmSync(path.join(FIXTURES, d, '.codemaster'), { recursive: true, force: true });
});

test('small-python: indexes functions and import edge', () => {
  const api = new StaticAnalysisAPI(path.join(FIXTURES, 'small-python'));
  assert.ok(api.findDefinition('helper').length >= 1);
  assert.ok(api.findDefinition('main').length >= 1);
  assert.deepEqual(api.getDependencies('app.py'), ['utils.py']);
});

test('legacy-codebase: detects the a<->b import cycle', () => {
  const api = new StaticAnalysisAPI(path.join(FIXTURES, 'legacy-codebase'));
  const cycles = api.getCycles();
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0]!.files.sort(), ['a.py', 'b.py']);
});

test('medium-monorepo: indexes multiple languages', () => {
  const api = new StaticAnalysisAPI(path.join(FIXTURES, 'medium-monorepo'));
  const stats = api.stats()!;
  assert.ok((stats.languages.typescript ?? 0) >= 1, `expected ts, got ${JSON.stringify(stats.languages)}`);
  assert.ok((stats.languages.python ?? 0) >= 1);
  assert.ok((stats.languages.go ?? 0) >= 1);
  assert.ok(api.findDefinition('startServer').length >= 1);
});

// G1 regression: an identifier mentioned LATE in the description (past the old
// 10-word cap) must still pull its defining file (spec §10.3).
test('file selector resolves a late-mentioned identifier', async () => {
  const api = new StaticAnalysisAPI(path.join(FIXTURES, 'medium-monorepo'));
  const task: Task = {
    id: 't', session_id: 's',
    title: 'extend the http layer',
    description: 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore using the Router class',
    type: 'implement', status: 'in_progress', input_files: [], output_files: [], dependencies: [],
    blocking: [], reasoning_refs: [], decision_refs: [], estimated_tokens: 0, order: 0,
  };
  const sel = await selectFiles(api, task, 50_000, 8000);
  assert.ok(sel.some((f) => /server\.ts$/.test(f.path)), `Router should pull api/server.ts, got ${sel.map((f) => f.path)}`);
});

// Gap #12 regression. The reported cause (the typescript grammar cannot read
// JSX) was wrong: it error-recovers around JSX and yields the same symbols and
// calls as the tsx grammar. The real defect was in resolveImport, which mapped
// `.js` to `.ts` only, so every `import ... from './Button'` in a React tree
// resolved to nothing and the dependency edge was silently dropped. The
// getDependencies assertion below is what catches it.
test('react-tsx: .tsx files produce symbols and call edges', () => {
  const api = new StaticAnalysisAPI(path.join(FIXTURES, 'react-tsx'));

  assert.ok(api.findDefinition('Button').length >= 1, 'Button component not indexed');
  assert.ok(api.findDefinition('Panel').length >= 1, 'Panel component not indexed');

  assert.deepEqual(api.getDependencies('Panel.tsx').sort(), ['Button.tsx', 'hooks.ts']);

  const callers = api.getCallers('formatLabel');
  assert.ok(
    callers.some((c) => c.file.includes('Button.tsx')),
    `expected Button.tsx to call formatLabel, got ${JSON.stringify(callers)}`,
  );
});
