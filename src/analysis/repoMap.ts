// Repository Map Generator (spec §5.2.10) — deterministic hierarchical summary.

import path from 'path';
import { getRepoDb } from '../storage/db.js';

export interface ModuleSummary {
  name: string;
  files: number;
  key_files: string[];
  languages: string[];
}

export interface RepositoryMap {
  total_files: number;
  languages: Record<string, string>; // language -> percentage string
  top_level_modules: ModuleSummary[];
}

export function generateRepositoryMap(repoPath: string, depth = 2): RepositoryMap {
  const db = getRepoDb(repoPath);
  const files = db.prepare('SELECT path, language FROM file_index').all() as Array<{
    path: string;
    language: string;
  }>;

  const total = files.length;
  const langCounts: Record<string, number> = {};
  for (const f of files) langCounts[f.language] = (langCounts[f.language] ?? 0) + 1;

  const languages: Record<string, string> = {};
  for (const [lang, count] of Object.entries(langCounts).sort((a, b) => b[1] - a[1])) {
    languages[lang] = total ? `${Math.round((count / total) * 100)}%` : '0%';
  }

  // Group by top-level directory (depth-1 module granularity).
  const modules = new Map<string, { files: string[]; langs: Set<string> }>();
  for (const f of files) {
    const parts = f.path.split(path.sep);
    const key = parts.length > 1 ? parts.slice(0, Math.min(depth - 1, parts.length - 1)).join(path.sep) : '.';
    const mod = modules.get(key) ?? { files: [], langs: new Set() };
    mod.files.push(f.path);
    mod.langs.add(f.language);
    modules.set(key, mod);
  }

  const top_level_modules: ModuleSummary[] = [...modules.entries()]
    .map(([name, m]) => ({
      name,
      files: m.files.length,
      key_files: pickKeyFiles(repoPath, m.files),
      languages: [...m.langs],
    }))
    .sort((a, b) => b.files - a.files);

  return { total_files: total, languages, top_level_modules };
}

// Key files = most-referenced + conventional entry points.
function pickKeyFiles(repoPath: string, files: string[]): string[] {
  const db = getRepoDb(repoPath);
  const ENTRY = ['index', 'main', 'app', '__init__', 'mod', 'lib'];
  const scored = files.map((f) => {
    const base = path.basename(f, path.extname(f)).toLowerCase();
    const exp = db.prepare('SELECT exports_json FROM file_index WHERE path=?').get(f) as
      | { exports_json: string }
      | undefined;
    let score = 0;
    if (ENTRY.includes(base)) score += 10;
    try {
      score += (JSON.parse(exp?.exports_json ?? '[]') as string[]).length;
    } catch {
      /* ignore */
    }
    return { f, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.f);
}

export function renderRepositoryMap(map: RepositoryMap, maxModules = 15): string {
  const lines: string[] = [];
  lines.push(`Total files: ${map.total_files}`);
  lines.push(`Languages: ${Object.entries(map.languages).map(([l, p]) => `${l} ${p}`).join(', ')}`);
  lines.push('');
  lines.push('Top-level modules:');
  for (const m of map.top_level_modules.slice(0, maxModules)) {
    lines.push(`  ${m.name}/ (${m.files} files, ${m.languages.join('/')})`);
    if (m.key_files.length) lines.push(`    key: ${m.key_files.join(', ')}`);
  }
  return lines.join('\n');
}
