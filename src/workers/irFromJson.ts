// Native JSON → IntermediateRepresentation parser (spec §15.1, §15.3).
// Used by adapters whose providers emit structured JSON (OpenAI, Gemini) rather
// than Claude-style XML. Falls back to the XML parser when the body is not JSON.

import { ParseError, parseIR } from './outputParser.js';
import { id, now } from '../util/id.js';
import type {
  IntermediateRepresentation,
  IRStatus,
  Patch,
  NewFile,
  Decision,
  Risk,
  Observation,
  Assumption,
  ProviderRef,
  TaskSpec,
  WikiUpdate,
} from '../types/index.js';

const VALID_STATUS: IRStatus[] = ['completed', 'partial', 'failed', 'blocked', 'needs_clarification'];

interface JsonIR {
  status?: string;
  summary?: string;
  patches?: Array<{ file?: string; diff?: string }>;
  files_created?: Array<{ path?: string; content?: string }>;
  files_deleted?: string[];
  decisions?: Array<Record<string, unknown>>;
  observations?: Array<Record<string, unknown>>;
  risks?: Array<Record<string, unknown>>;
  assumptions?: Array<Record<string, unknown>>;
  wiki_updates?: Array<{ key?: string; content?: string }>;
  next_tasks?: Array<{ title?: string; type?: string; priority?: string; description?: string; depends_on?: string[] }>;
  open_questions?: string[];
  blocked_by?: string[];
  confidence?: number;
}

function extractJson(raw: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = fence ? fence[1]! : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

export function irFromJson(
  raw: string,
  sessionId: string,
  taskId: string,
  producedBy: ProviderRef,
): IntermediateRepresentation {
  const jsonStr = extractJson(raw);
  let data: JsonIR | null = null;
  if (jsonStr) {
    try {
      data = JSON.parse(jsonStr) as JsonIR;
    } catch {
      data = null;
    }
  }
  // Not valid JSON — the model may have emitted XML anyway; fall back.
  if (!data) {
    try {
      return parseIR(raw, sessionId, taskId, producedBy);
    } catch {
      throw new ParseError('Model output was neither valid JSON nor a <task_result> block');
    }
  }

  const statusRaw = (data.status ?? 'completed').toLowerCase();
  const status = (VALID_STATUS.includes(statusRaw as IRStatus) ? statusRaw : 'completed') as IRStatus;

  const base = () => ({
    id: id('reasoning'),
    session_id: sessionId,
    task_id: taskId,
    produced_by: producedBy,
    produced_at: now(),
    affected_files: [] as never[],
    affected_modules: [] as string[],
    tags: [] as string[],
    permanent: true,
    wiki_keys: [] as string[],
    reference_count: 0,
    importance: 0.6,
    evidence: [] as never[],
  });

  const patches: Patch[] = (data.patches ?? [])
    .filter((p) => p.diff)
    .map((p) => ({ file: p.file ?? 'unknown', diff: p.diff! }));

  const files_created: NewFile[] = (data.files_created ?? [])
    .filter((f) => f.path)
    .map((f) => ({ path: f.path!, content: f.content ?? '' }));

  const decisions: Decision[] = (data.decisions ?? []).map((d) => ({
    ...base(),
    type: 'decision',
    summary: str(d.answer) || str(d.question) || str(d.summary) || 'decision',
    detail: str(d.detail) || str(d.answer),
    question: str(d.question),
    answer: str(d.answer),
    confidence: numv(d.confidence, 0.7),
    reversibility: (str(d.reversibility) as Decision['reversibility']) || 'medium',
    alternatives_rejected: Array.isArray(d.alternatives)
      ? (d.alternatives as Array<Record<string, unknown>>).map((a) => ({
          option: str(a.option),
          rejected_because: str(a.rejected_because) || str(a.reason),
        }))
      : [],
    implications: Array.isArray(d.implications) ? (d.implications as unknown[]).map(String) : [],
  })) as Decision[];

  const risks: Risk[] = (data.risks ?? []).map((r) => ({
    ...base(),
    type: 'risk',
    summary: (str(r.description) || 'risk').slice(0, 120),
    detail: str(r.description),
    confidence: numv(r.confidence, 0.7),
    risk_description: str(r.description),
    likelihood: (str(r.likelihood) as Risk['likelihood']) || 'medium',
    impact: (str(r.impact) as Risk['impact']) || 'medium',
    mitigation_strategy: str(r.mitigation) || undefined,
    status: 'open',
  })) as Risk[];

  const observations: Observation[] = (data.observations ?? []).map((o) => ({
    ...base(),
    type: 'observation',
    summary: (str(o.summary) || str(o.detail)).slice(0, 120),
    detail: str(o.detail) || str(o.summary),
    confidence: numv(o.confidence, 0.7),
  })) as Observation[];

  const assumptions: Assumption[] = (data.assumptions ?? []).map((a) => ({
    ...base(),
    type: 'assumption',
    summary: (str(a.summary) || str(a.detail)).slice(0, 120),
    detail: str(a.detail) || str(a.summary),
    confidence: numv(a.confidence, 0.6),
  })) as Assumption[];

  const wiki_updates: WikiUpdate[] = (data.wiki_updates ?? [])
    .filter((w) => w.key)
    .map((w) => ({ key: w.key!, content: w.content ?? '', is_diff: false }));

  const next_tasks: TaskSpec[] = (data.next_tasks ?? [])
    .filter((t) => t.title)
    .map((t) => ({
      title: t.title!,
      description: t.description,
      type: t.type as TaskSpec['type'],
      priority: (t.priority as TaskSpec['priority']) ?? 'medium',
      depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
    }));

  const allConf = [...decisions, ...observations].map((x) => x.confidence);
  const overall = data.confidence ?? (allConf.length ? allConf.reduce((a, b) => a + b, 0) / allConf.length : 0.7);

  return {
    ir_version: '1.0',
    session_id: sessionId,
    task_id: taskId,
    produced_by: producedBy,
    produced_at: now(),
    status,
    summary: str(data.summary),
    patches,
    files_created,
    files_deleted: (data.files_deleted ?? []).map((p) => ({ path: p })),
    files_renamed: [],
    decisions,
    observations,
    risks,
    assumptions,
    wiki_updates,
    wiki_reads: [],
    next_tasks,
    blocked_by: data.blocked_by ?? [],
    open_questions: (data.open_questions ?? []).map((q) => ({ text: q })),
    clarification_needed: status === 'needs_clarification' ? str(data.summary) : undefined,
    overall_confidence: overall,
    raw_output: raw,
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function numv(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
