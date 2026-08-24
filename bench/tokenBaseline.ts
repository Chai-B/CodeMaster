// Token-discipline baseline (plan §6). Reports the waste classes that are
// currently measurable from recorded data, and states plainly which are not.
// Run: node --import tsx bench/tokenBaseline.ts
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../src/config.js';

interface UsageRow {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  context_components_json: string | null;
  wasted_tokens: number | null;
}

const db = new DatabaseSync(DB_PATH);
const rows = db.prepare('SELECT * FROM token_usage ORDER BY invocation_at').all() as unknown as UsageRow[];
if (rows.length === 0) {
  console.log('no token_usage rows; run a session or bench first');
  process.exit(0);
}

const isWorker = (r: UsageRow): boolean => {
  const c = JSON.parse(r.context_components_json || '[]') as string[];
  return c.length === 1 && c[0] === 'worker';
};

const sum = (f: (r: UsageRow) => number): number => rows.reduce((a, r) => a + f(r), 0);
const input = sum((r) => r.input_tokens);
const cacheRead = sum((r) => r.cache_read_tokens ?? 0);
const cacheWrite = sum((r) => r.cache_write_tokens ?? 0);

const pct = (n: number): string => `${((100 * n) / input).toFixed(1)}%`;
const group = (name: string, rs: UsageRow[]): void => {
  if (!rs.length) return;
  const i = rs.reduce((a, r) => a + r.input_tokens, 0);
  const o = rs.reduce((a, r) => a + r.output_tokens, 0);
  console.log(
    `  ${name.padEnd(7)} n=${String(rs.length).padStart(3)}  input=${i.toLocaleString().padStart(12)}` +
      `  output=${o.toLocaleString().padStart(9)}  avg_in=${Math.round(i / rs.length).toLocaleString().padStart(9)}` +
      `  in:out=${(i / Math.max(1, o)).toFixed(0)}:1`,
  );
};

console.log(`invocations: ${rows.length}`);
console.log(`input:  ${input.toLocaleString()}   output: ${sum((r) => r.output_tokens).toLocaleString()}`);
console.log(`cache:  read ${cacheRead.toLocaleString()} (${pct(cacheRead)})  write ${cacheWrite.toLocaleString()} (${pct(cacheWrite)})  uncached ${(input - cacheRead - cacheWrite).toLocaleString()} (${pct(input - cacheRead - cacheWrite)})`);
console.log('by call kind:');
group('worker', rows.filter(isWorker));
group('task', rows.filter((r) => !isWorker(r)));

// W3 requires per-component token counts and the selected file set, neither of
// which context_components_json records today. Report honestly rather than guess.
const instrumented = rows.filter((r) => r.wasted_tokens != null).length;
console.log(`\nW3 wasteRatio: NOT COMPUTABLE (${instrumented}/${rows.length} rows have wasted_tokens;`);
console.log('  context_components_json stores component names only -- no per-component');
console.log('  token counts and no file list. Instrumenting this is plan phase 3, W3.)');
