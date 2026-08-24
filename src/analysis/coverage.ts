// Coverage integration (spec §5.2.9) — parse lcov / Istanbul / tarpaulin outputs.

import fs from 'fs';
import path from 'path';
import { getRepoDb } from '../storage/db.js';

export interface CoverageReport {
  file: string;
  covered: number;
  total: number;
  pct: number;
  coveredLines: number[];
}

const CANDIDATES = [
  'coverage/lcov.info',
  'lcov.info',
  'coverage/coverage-final.json',
  'cobertura.xml',
  'tarpaulin-report.json',
];

export function findCoverageFile(repoPath: string): string | null {
  for (const c of CANDIDATES) {
    const full = path.join(repoPath, c);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

export function importCoverage(repoPath: string): number {
  const file = findCoverageFile(repoPath);
  if (!file) return 0;
  let reports: CoverageReport[] = [];
  try {
    if (file.endsWith('lcov.info')) reports = parseLcov(fs.readFileSync(file, 'utf8'), repoPath);
    else if (file.endsWith('.json')) reports = parseIstanbul(JSON.parse(fs.readFileSync(file, 'utf8')), repoPath);
  } catch {
    return 0;
  }
  const db = getRepoDb(repoPath);
  db.exec('DELETE FROM coverage;');
  const ins = db.prepare(
    'INSERT OR REPLACE INTO coverage (file_path, covered_lines_json, total_lines, covered, pct) VALUES (?,?,?,?,?)',
  );
  for (const r of reports) {
    ins.run(r.file, JSON.stringify(r.coveredLines), r.total, r.covered, r.pct);
  }
  return reports.length;
}

export function getCoverage(repoPath: string, file?: string): CoverageReport[] {
  const db = getRepoDb(repoPath);
  const rows = file
    ? (db.prepare('SELECT * FROM coverage WHERE file_path=?').all(file) as Array<Record<string, unknown>>)
    : (db.prepare('SELECT * FROM coverage').all() as Array<Record<string, unknown>>);
  return rows.map((r) => ({
    file: r.file_path as string,
    covered: r.covered as number,
    total: r.total_lines as number,
    pct: r.pct as number,
    coveredLines: JSON.parse((r.covered_lines_json as string) ?? '[]'),
  }));
}

export function getUncoveredFunctions(repoPath: string): Array<{ name: string; file: string; line: number }> {
  const db = getRepoDb(repoPath);
  const cov = getCoverage(repoPath);
  const covByFile = new Map(cov.map((c) => [c.file, new Set(c.coveredLines)]));
  const fns = db
    .prepare("SELECT name, file_path, line_start FROM symbols WHERE kind IN ('function','method')")
    .all() as Array<{ name: string; file_path: string; line_start: number }>;
  const out: Array<{ name: string; file: string; line: number }> = [];
  for (const f of fns) {
    const covered = covByFile.get(f.file_path);
    if (covered && !covered.has(f.line_start)) out.push({ name: f.name, file: f.file_path, line: f.line_start });
  }
  return out;
}

function parseLcov(text: string, repoPath: string): CoverageReport[] {
  const out: CoverageReport[] = [];
  let file = '';
  let coveredLines: number[] = [];
  let total = 0;
  let covered = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      file = path.relative(repoPath, line.slice(3).trim());
      coveredLines = [];
      total = 0;
      covered = 0;
    } else if (line.startsWith('DA:')) {
      const [ln, hits] = line.slice(3).split(',').map(Number);
      total += 1;
      if ((hits ?? 0) > 0) {
        covered += 1;
        coveredLines.push(ln!);
      }
    } else if (line.startsWith('end_of_record')) {
      out.push({ file, covered, total, pct: total ? (covered / total) * 100 : 0, coveredLines });
    }
  }
  return out;
}

function parseIstanbul(json: Record<string, any>, repoPath: string): CoverageReport[] {
  const out: CoverageReport[] = [];
  for (const [absFile, data] of Object.entries(json)) {
    const statementMap = data.statementMap ?? {};
    const s = data.s ?? {};
    const coveredLines: number[] = [];
    let total = 0;
    let covered = 0;
    for (const [key, loc] of Object.entries<any>(statementMap)) {
      total += 1;
      const hit = s[key] ?? 0;
      if (hit > 0) {
        covered += 1;
        if (loc.start?.line) coveredLines.push(loc.start.line);
      }
    }
    out.push({
      file: path.relative(repoPath, absFile),
      covered,
      total,
      pct: total ? (covered / total) * 100 : 0,
      coveredLines,
    });
  }
  return out;
}
