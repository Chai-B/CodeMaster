// OutputParser — raw model output → IntermediateRepresentation (spec §15.3, §12.2).
// Deterministic XML extraction. Never calls an LLM.

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

export class ParseError extends Error {}

function tagBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  for (let m; (m = re.exec(xml)); ) out.push(m[2] ?? '');
  return out;
}

function tagBlocksWithAttrs(xml: string, tag: string): Array<{ attrs: Record<string, string>; body: string }> {
  const re = new RegExp(`<${tag}((?:\\s[^>]*)?)\\s*(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  const out: Array<{ attrs: Record<string, string>; body: string }> = [];
  for (let m; (m = re.exec(xml)); ) out.push({ attrs: parseAttrs(m[1] ?? ''), body: m[2] ?? '' });
  return out;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w-]+)\s*=\s*"([^"]*)"/g;
  for (let m; (m = re.exec(s)); ) out[m[1]!] = m[2]!;
  return out;
}

function firstTag(xml: string, tag: string): string | undefined {
  return tagBlocks(xml, tag)[0]?.trim();
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseIR(
  raw: string,
  sessionId: string,
  taskId: string,
  producedBy: ProviderRef,
): IntermediateRepresentation {
  const m = /<task_result>([\s\S]*?)<\/task_result>/.exec(raw);
  if (!m) {
    throw new ParseError('No <task_result> block found in model output');
  }
  const xml = m[1]!;

  const statusRaw = (firstTag(xml, 'status') ?? 'completed').toLowerCase();
  const validStatuses: IRStatus[] = ['completed', 'partial', 'failed', 'blocked', 'needs_clarification'];
  const status = (validStatuses.includes(statusRaw as IRStatus) ? statusRaw : 'completed') as IRStatus;

  const patches: Patch[] = tagBlocksWithAttrs(xml, 'patch').map((b) => ({
    file: b.attrs.file ?? 'unknown',
    diff: unescapeXml(b.body.trim()),
  }));

  const files_created: NewFile[] = tagBlocksWithAttrs(xml, 'file')
    .filter((b) => b.attrs.path)
    .map((b) => ({ path: b.attrs.path!, content: unescapeXml(b.body.replace(/^\n/, '').replace(/\n$/, '')) }));

  const reasoningXml = firstTag(xml, 'reasoning') ?? '';
  const base = (extra: Partial<Decision>) => ({
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
    ...extra,
  });

  const decisions: Decision[] = tagBlocksWithAttrs(reasoningXml, 'decision').map((b) => ({
    ...base({}),
    type: 'decision',
    summary: b.attrs.answer ?? b.attrs.question ?? 'decision',
    detail: b.body.trim(),
    question: b.attrs.question ?? '',
    answer: b.attrs.answer ?? '',
    confidence: num(b.attrs.confidence, 0.7),
    reversibility: (b.attrs.reversibility as Decision['reversibility']) ?? 'medium',
    alternatives_rejected: tagBlocksWithAttrs(b.body, 'alternative').map((a) => ({
      option: a.attrs.option ?? '',
      rejected_because: a.attrs.rejected_because ?? a.body.trim(),
    })),
    implications: tagBlocks(b.body, 'implication').map((s) => s.trim()),
    evidence: tagBlocks(b.body, 'evidence').map((s) => ({ description: s.trim() })),
  })) as Decision[];

  const risks: Risk[] = tagBlocksWithAttrs(reasoningXml, 'risk').map((b) => ({
    ...base({}),
    type: 'risk',
    summary: (firstTag(b.body, 'description') ?? 'risk').slice(0, 120),
    detail: b.body.trim(),
    confidence: 0.7,
    risk_description: firstTag(b.body, 'description') ?? b.body.trim(),
    likelihood: (b.attrs.likelihood as Risk['likelihood']) ?? 'medium',
    impact: (b.attrs.impact as Risk['impact']) ?? 'medium',
    mitigation_strategy: firstTag(b.body, 'mitigation'),
    status: 'open',
  })) as Risk[];

  const observations: Observation[] = tagBlocksWithAttrs(reasoningXml, 'observation').map((b) => ({
    ...base({}),
    type: 'observation',
    summary: b.body.trim().slice(0, 120),
    detail: b.body.trim(),
    confidence: num(b.attrs.confidence, 0.7),
  })) as Observation[];

  const assumptions: Assumption[] = tagBlocksWithAttrs(reasoningXml, 'assumption').map((b) => ({
    ...base({}),
    type: 'assumption',
    summary: b.body.trim().slice(0, 120),
    detail: b.body.trim(),
    confidence: num(b.attrs.confidence, 0.6),
  })) as Assumption[];

  const wiki_updates: WikiUpdate[] = tagBlocksWithAttrs(xml, 'update')
    .filter((b) => b.attrs.key)
    .map((b) => ({ key: b.attrs.key!, content: b.body.trim(), is_diff: false }));

  const next_tasks: TaskSpec[] = tagBlocksWithAttrs(xml, 'task').map((b) => ({
    title: b.body.trim(),
    priority: (b.attrs.priority as TaskSpec['priority']) ?? 'medium',
    type: b.attrs.type as TaskSpec['type'],
  }));

  const open_questions = tagBlocks(firstTag(xml, 'open_questions') ?? '', 'question').map((q) => ({
    text: q.trim(),
  }));

  const clarification = status === 'needs_clarification' ? firstTag(xml, 'summary') : undefined;

  return {
    ir_version: '1.0',
    session_id: sessionId,
    task_id: taskId,
    produced_by: producedBy,
    produced_at: now(),
    status,
    summary: firstTag(xml, 'summary') ?? '',
    patches,
    files_created,
    files_deleted: [],
    files_renamed: [],
    decisions,
    observations,
    risks,
    assumptions,
    wiki_updates,
    wiki_reads: [],
    next_tasks,
    blocked_by: tagBlocks(xml, 'blocked_by').map((s) => s.trim()),
    open_questions,
    clarification_needed: clarification,
    overall_confidence: avgConfidence(decisions, observations),
    raw_output: raw,
  };
}

function num(s: string | undefined, fallback: number): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

function avgConfidence(decisions: Decision[], observations: Observation[]): number {
  const all = [...decisions, ...observations];
  if (!all.length) return 0.7;
  return all.reduce((a, x) => a + x.confidence, 0) / all.length;
}
