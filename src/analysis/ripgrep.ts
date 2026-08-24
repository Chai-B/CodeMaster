// RipgrepWorker — text-pattern search at filesystem scale (spec §5.2.7).
// Falls back to a node-based recursive grep if rg is not installed.

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface SearchResult {
  file: string;
  line: number;
  column: number;
  text: string;
}

export interface SearchOptions {
  glob?: string;
  maxResults?: number;
  caseInsensitive?: boolean;
}

let rgAvailable: boolean | null = null;
function hasRg(): boolean {
  if (rgAvailable !== null) return rgAvailable;
  const r = spawnSync('rg', ['--version'], { encoding: 'utf8' });
  rgAvailable = r.status === 0;
  return rgAvailable;
}

export function search(repoPath: string, pattern: string, opts: SearchOptions = {}): SearchResult[] {
  const max = opts.maxResults ?? 200;
  if (hasRg()) {
    const args = ['--json', '--max-count', String(max)];
    if (opts.caseInsensitive) args.push('-i');
    if (opts.glob) args.push('--glob', opts.glob);
    args.push(pattern, repoPath);
    const r = spawnSync('rg', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    const out: SearchResult[] = [];
    for (const line of (r.stdout ?? '').split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.type === 'match') {
          out.push({
            file: path.relative(repoPath, j.data.path.text),
            line: j.data.line_number,
            column: (j.data.submatches?.[0]?.start ?? 0) + 1,
            text: (j.data.lines.text ?? '').trimEnd(),
          });
          if (out.length >= max) break;
        }
      } catch {
        /* skip malformed */
      }
    }
    return out;
  }
  return nodeGrep(repoPath, pattern, max, opts.caseInsensitive ?? false);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.codemaster', 'build', '.next']);

function nodeGrep(repoPath: string, pattern: string, max: number, ci: boolean): SearchResult[] {
  const re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ci ? 'i' : '');
  const out: SearchResult[] = [];
  const walk = (dir: string) => {
    if (out.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile()) {
        let content: string;
        try {
          const stat = fs.statSync(full);
          if (stat.size > 1_000_000) continue;
          content = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const m = re.exec(lines[i]!);
          if (m) {
            out.push({ file: path.relative(repoPath, full), line: i + 1, column: m.index + 1, text: lines[i]!.trim() });
            if (out.length >= max) return;
          }
        }
      }
    }
  };
  walk(repoPath);
  return out;
}
