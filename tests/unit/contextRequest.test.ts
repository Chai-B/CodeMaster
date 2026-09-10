import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolveContextRequests } from '../../src/workers/contextResolver.js';
import { indexFile } from '../../src/analysis/indexer.js';

test('resolveContextRequests resolves file slicing, grep, and missing symbols deterministically', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ctx-test-'));
  const testFile = path.join(tmpDir, 'sample.ts');
  const content = `// Line 1
export function greet(name: string): string {
  return "Hello, " + name;
}
// Line 5
export const API_ENDPOINT = "https://api.example.com";
// Line 7
`;
  fs.writeFileSync(testFile, content, 'utf8');

  // Index the file into the repo DB so symbols are populated
  await indexFile(tmpDir, 'sample.ts');

  const res = await resolveContextRequests(tmpDir, [
    { type: 'file', target: 'sample.ts', slice: '2-4' },
    { type: 'symbol', target: 'greet' },
    { type: 'symbol', target: 'nonExistentSymbol' },
    { type: 'grep', target: 'API_ENDPOINT' },
    { type: 'callers_of', target: 'greet' },
  ]);

  assert.ok(res.resolvedCount >= 3, `Expected at least 3 resolved, got ${res.resolvedCount}`);
  assert.ok(res.xml.includes('<context_response>'));
  assert.ok(res.xml.includes('</context_response>'));

  // File slice
  assert.ok(res.xml.includes('<file path="sample.ts" slice="2-4" status="found">'));
  assert.ok(res.xml.includes('export function greet'));

  // Symbol found
  assert.ok(res.xml.includes('<symbol name="greet" status="found"'));

  // Missing symbol
  assert.ok(res.xml.includes('<symbol name="nonExistentSymbol" status="not_found" />'));

  // Grep
  assert.ok(res.xml.includes('<grep pattern="API_ENDPOINT" count="1">'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
