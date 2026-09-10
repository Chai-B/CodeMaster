import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { findSymbolSpan, applySymbolEdits, applyPatches } from '../../src/workers/patchApplier.js';

test('findSymbolSpan accurately bounds TypeScript functions with nested braces', async () => {
  const tsCode = `
import { something } from './somewhere';

export function calculateTotal(items: Array<{ price: number; tax: boolean }>): number {
  let total = 0;
  for (const item of items) {
    if (item.tax) {
      total += item.price * 1.1;
    } else {
      total += item.price;
    }
  }
  return total;
}

export function helper(): void {
  // helper code
}
`;

  const span = await findSymbolSpan(tsCode, 'calc.ts', 'calculateTotal');
  assert.ok(span !== null, 'Should find calculateTotal');
  const extracted = tsCode.slice(span.start, span.end);
  assert.ok(extracted.startsWith('export function calculateTotal'));
  assert.ok(extracted.endsWith('return total;\n}'));
});

test('findSymbolSpan accurately bounds Python functions with indentation and decorators', async () => {
  const pyCode = `
import os

@decorator_one
@decorator_two(arg="val")
def compute_data(x, y):
    # inner comment
    if x > 0:
        return x * y
    return 0

def next_function():
    pass
`;

  const span = await findSymbolSpan(pyCode, 'service.py', 'compute_data');
  assert.ok(span !== null, 'Should find compute_data');
  const extracted = pyCode.slice(span.start, span.end);
  assert.ok(extracted.startsWith('@decorator_one'));
  assert.ok(extracted.includes('def compute_data(x, y):'));
  assert.ok(!extracted.includes('next_function'));
});

test('applySymbolEdits surgically replaces symbol content and records undo', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-sym-test-'));
  const testFile = path.join(tmpDir, 'math.ts');
  const original = `export function add(a: number, b: number): number {
  return a + b;
}

export function sub(a: number, b: number): number {
  return a - b;
}
`;
  fs.writeFileSync(testFile, original, 'utf8');

  const res = await applySymbolEdits(tmpDir, [
    {
      file: 'math.ts',
      symbol: 'add',
      content: `export function add(a: number, b: number): number {\n  return a + b + 42;\n}`,
    },
  ]);

  assert.deepEqual(res.applied, ['math.ts']);
  assert.equal(res.failed.length, 0);
  assert.equal(res.undo.length, 1);
  assert.equal(res.undo[0]?.before, original);

  const updated = fs.readFileSync(testFile, 'utf8');
  assert.ok(updated.includes('return a + b + 42;'));
  assert.ok(updated.includes('export function sub(a: number, b: number): number {'));

  // Test applyPatches integration
  const res2 = await applyPatches(
    tmpDir,
    [],
    [],
    {},
    [
      {
        file: 'math.ts',
        symbol: 'sub',
        content: `export function sub(a: number, b: number): number {\n  return a - b - 1;\n}`,
      },
    ],
  );
  assert.deepEqual(res2.applied, ['math.ts']);
  const updated2 = fs.readFileSync(testFile, 'utf8');
  assert.ok(updated2.includes('return a - b - 1;'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
