import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runGreenfieldVerification, makeGreenfieldVerify } from '../../src/workers/verify/greenfieldVerify.js';

test('runGreenfieldVerification passes when code compiles and exports match criteria', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-green-test-'));

  const scriptFile = path.join(tmpDir, 'service.ts');
  fs.writeFileSync(
    scriptFile,
    `export function calculateMetrics(): { uptime: number } {
  return { uptime: 100 };
}
`,
    'utf8',
  );

  const res = await runGreenfieldVerification(tmpDir, ['service.ts'], {
    targetFiles: ['service.ts'],
    expectedExports: {
      'service.ts': ['calculateMetrics'],
    },
  });

  assert.equal(res.ok, true);
  assert.ok(res.checksRun >= 2);
  assert.ok(res.output.includes('passed'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runGreenfieldVerification detects missing expected exports', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-green-test-'));

  const scriptFile = path.join(tmpDir, 'service.ts');
  fs.writeFileSync(scriptFile, `export const x = 1;\n`, 'utf8');

  const res = await runGreenfieldVerification(tmpDir, ['service.ts'], {
    targetFiles: ['service.ts'],
    expectedExports: {
      'service.ts': ['missingFunction'],
    },
  });

  assert.equal(res.ok, false);
  assert.ok(res.output.includes("Expected export 'missingFunction' was not found"));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('makeGreenfieldVerify conforms to VerifyFn contract in solver', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-green-test-'));

  const file = path.join(tmpDir, 'module.js');
  fs.writeFileSync(file, `export const version = "1.0.0";\n`, 'utf8');

  const verifyFn = makeGreenfieldVerify(tmpDir, () => ['module.js']);
  const result = await verifyFn(['module.js']);

  assert.equal(result.ok, true);
  assert.equal(result.confident, true);
  assert.equal(result.actionable, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
