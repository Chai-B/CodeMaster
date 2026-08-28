// Unvisited use sites (spec §5.4, plan §5-C). The classic false confidence in
// an agentic fix is a patch that changes a definition, passes every test that
// happens to exist, and silently breaks every caller that has no test. This
// compares the signatures now on disk against the ones the index recorded
// before the patch and reports the callers of every signature that moved which
// the patch itself never opened. Deterministic, zero LLM calls.

import fs from 'fs';
import path from 'path';
import { getRepoDb } from '../storage/db.js';
import { languageOf } from './extractors.js';
import { extractWithFallback } from './treesitter.js';
import { callGraph } from './callGraph.js';
import { dependencyGraph } from './depGraph.js';
import { isTestFile } from '../util/testFiles.js';

export interface UseSiteGap {
  symbol: string;
  definedIn: string;
  usedIn: string[];
}

const CALLABLE = new Set(['function', 'method', 'class']);

/** Signatures are compared as text, so incidental reformatting must not read as
 *  a contract change. */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export async function unvisitedUseSites(repoPath: string, changedFiles: string[]): Promise<UseSiteGap[]> {
  const db = getRepoDb(repoPath);
  const changed = new Set(changedFiles);
  const gaps: UseSiteGap[] = [];
  const graph = callGraph(repoPath);
  const deps = dependencyGraph(repoPath);

  const root = path.resolve(repoPath) + path.sep;
  for (const rel of changedFiles) {
    if (isTestFile(rel)) continue;
    // The working directory is the boundary: a path that resolves above it
    // belongs to someone else's repository and is not ours to gate on.
    if (!(path.resolve(repoPath, rel) + path.sep).startsWith(root)) continue;
    const lang = languageOf(rel);
    if (!lang) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(repoPath, rel), 'utf8');
    } catch {
      continue; // deleted by the patch; the dependency graph already covers that
    }

    const rows = db
      .prepare('SELECT name, signature, kind FROM symbols WHERE file_path=?')
      .all(rel) as Array<{ name: string; signature: string | null; kind: string }>;
    const before = new Map(rows.filter((r) => CALLABLE.has(r.kind)).map((r) => [r.name, norm(r.signature ?? '')]));
    // Never indexed — there is no "before" to compare against, and guessing one
    // would manufacture failures.
    if (before.size === 0) continue;

    const ex = await extractWithFallback(content, lang);
    const after = new Map(ex.symbols.filter((s) => CALLABLE.has(s.kind)).map((s) => [s.name, norm(s.signature)]));

    // Dependents of this file, so a same-named symbol in an unrelated module
    // cannot be mistaken for a caller of this one.
    const dependents = new Set(deps.dependents(rel, false));

    for (const [name, sig] of before) {
      const nowSig = after.get(name);
      // A body-only edit keeps the signature identical and breaks no caller.
      // Only a moved or removed signature obliges the patch to visit use sites.
      if (nowSig !== undefined && nowSig === sig) continue;
      const usedIn = [...new Set(graph.callersOf(name).map((c) => c.file))].filter(
        (f) => f !== rel && !changed.has(f) && !isTestFile(f) && dependents.has(f),
      );
      if (usedIn.length) gaps.push({ symbol: name, definedIn: rel, usedIn });
    }
  }
  return gaps;
}

/** The directive handed back to the solver when the gate fires. */
export function describeUseSiteGaps(gaps: UseSiteGap[]): string {
  const lines = gaps
    .slice(0, 8)
    .map((g) => `- \`${g.symbol}\` (defined in ${g.definedIn}) is used by: ${g.usedIn.slice(0, 6).join(', ')}`);
  return (
    `You changed the signature of code that other files call, but you did not open those files:\n${lines.join('\n')}\n\n` +
    `Every call site above still passes the old arguments or expects the old return shape, and the tests that ran do not cover them. ` +
    `Either update those call sites in the same patch, or change the definition back to a compatible signature and fix the bug without breaking its contract.`
  );
}
