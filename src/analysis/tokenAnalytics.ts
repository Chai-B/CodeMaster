// Token analytics (spec §20.3) — efficiency metrics over the token ledger.

import { getDb } from '../storage/db.js';

export interface TaskTypeStats {
  type: string;
  invocations: number;
  total_tokens: number;
  avg_tokens: number;
}

export function tokensByTaskType(sessionId?: string): TaskTypeStats[] {
  const db = getDb();
  const where = sessionId ? 'WHERE t.session_id = ?' : '';
  const rows = db
    .prepare(
      `SELECT COALESCE(tk.type,'unknown') type, COUNT(*) n, SUM(u.total_tokens) tot
       FROM token_usage u
       LEFT JOIN tasks tk ON tk.id = u.task_id
       ${where ? where.replace('t.session_id', 'u.session_id') : ''}
       GROUP BY tk.type`,
    )
    .all(...(sessionId ? [sessionId] : [])) as Array<{ type: string; n: number; tot: number }>;
  return rows.map((r) => ({
    type: r.type ?? 'unknown',
    invocations: r.n,
    total_tokens: r.tot ?? 0,
    avg_tokens: r.n ? Math.round((r.tot ?? 0) / r.n) : 0,
  }));
}

export interface ProfileResult {
  task_id: string;
  invocations: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  components: string[];
}

export function profileTask(taskId: string): ProfileResult | null {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM token_usage WHERE task_id=?').all(taskId) as Array<Record<string, unknown>>;
  if (!rows.length) return null;
  let input = 0;
  let output = 0;
  let cost = 0;
  const components = new Set<string>();
  for (const r of rows) {
    input += (r.input_tokens as number) ?? 0;
    output += (r.output_tokens as number) ?? 0;
    cost += (r.cost_usd as number) ?? 0;
    try {
      for (const c of JSON.parse((r.context_components_json as string) ?? '[]') as string[]) components.add(c);
    } catch {
      /* ignore */
    }
  }
  return {
    task_id: taskId,
    invocations: rows.length,
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    cost_usd: cost,
    components: [...components],
  };
}

export interface ProviderEfficiency {
  provider: string;
  total_tokens: number;
  invocations: number;
  avg_output: number;
}

export function providerEfficiency(): ProviderEfficiency[] {
  const rows = getDb()
    .prepare(
      `SELECT provider_id, COUNT(*) n, SUM(total_tokens) tot, AVG(output_tokens) avgo
       FROM token_usage GROUP BY provider_id`,
    )
    .all() as Array<{ provider_id: string; n: number; tot: number; avgo: number }>;
  return rows.map((r) => ({
    provider: r.provider_id,
    total_tokens: r.tot ?? 0,
    invocations: r.n,
    avg_output: Math.round(r.avgo ?? 0),
  }));
}
