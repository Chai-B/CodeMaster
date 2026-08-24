// Canonical test-file detection (spec §5.2, §6). Single source of truth — the
// same regex was previously duplicated in rkg/store.ts and context/fileSelector.ts.
import fs from 'fs';
import path from 'path';

export function isTestFile(p: string): boolean {
  return /(\.test\.|\.spec\.|_test\.|test_|\/tests?\/|__tests__)/.test(p);
}

// On-disk sibling-test probe for a source file — the concrete test files that
// conventionally cover `rel`. Lives here (not fileSelector) to avoid an import
// cycle with analysis/api.
export function testFilesFor(repo: string, rel: string): string[] {
  const base = path.basename(rel).replace(/\.[^.]+$/, '');
  const dir = path.dirname(rel);
  const candidates = [
    path.join(dir, `${base}.test.ts`),
    path.join(dir, `${base}.spec.ts`),
    path.join('tests', `test_${base}.py`),
    path.join('test', `${base}_test.go`),
  ];
  return candidates.filter((c) => fs.existsSync(path.join(repo, c)));
}
