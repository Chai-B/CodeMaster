import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenJuice } from '../../src/workers/tokenJuice.js';

test('TokenJuice compresses lockfile diffs into compact summaries', () => {
  const lockDiff = `diff --git a/package-lock.json b/package-lock.json
index 123456..789abc 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -10,15 +10,18 @@
+    "version": "2.0.0",
+    "resolved": "https://registry.npmjs.org/foo",
+    "integrity": "sha512-abc",
-    "version": "1.0.0",
-    "resolved": "https://registry.npmjs.org/foo-old",
diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,3 @@
-const a = 1;
+const a = 2;
`;

  const compressed = TokenJuice.compressDiff(lockDiff);
  assert.match(compressed, /TokenJuice: Generated\/lockfile diff compacted/);
  assert.match(compressed, /const a = 2;/);
  const savings = TokenJuice.tokenSavings(lockDiff, compressed);
  assert.ok(savings.savedTokens > 0);
  assert.ok(savings.percentSaved > 0);
});

test('TokenJuice strips internal runtime stack frames from test error traces', () => {
  const trace = `Error: expect(received).toBe(expected) // Object.is equality

Expected: "clean"
Received: "dirty"
    at TestContext.<anonymous> (/Users/chaitanyabansal/Codemaster/src/app.ts:42:12)
    at node:internal/test_runner/test:1325:25
    at node:internal/process/task_queues:104:5
    at async Test.run (node:internal/test_runner/test:1332:7)
`;

  const compressed = TokenJuice.compressTestTrace(trace);
  assert.match(compressed, /Expected: "clean"/);
  assert.match(compressed, /\/Users\/chaitanyabansal\/Codemaster\/src\/app\.ts:42:12/);
  assert.match(compressed, /runtime stack frames omitted/);
  assert.doesNotMatch(compressed, /node:internal\/process\/task_queues/);
});

test('TokenJuice strips null and empty values from JSON data', () => {
  const data = {
    keep: 'value',
    dropNull: null,
    dropEmptyObj: {},
    dropEmptyArr: [],
    nested: {
      a: 1,
      b: null,
    },
  };

  const compressed = TokenJuice.compressJson(data);
  const parsed = JSON.parse(compressed);
  assert.deepEqual(parsed, { keep: 'value', nested: { a: 1 } });
});
