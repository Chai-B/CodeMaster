// Reasoning Replay Engine (spec §8.4) — when onboarding a new session on a
// project with history, replay structured reasoning (not conversations).
// Pure display/query: never calls an LLM.

import { Reasoning, Failures } from '../storage/reasoning.js';
import { LongTerm } from '../storage/memory.js';
import type { ReasoningObject } from '../types/index.js';

export interface ReplayResult {
  reasoning: ReasoningObject[];
  failures: Array<{ approach: string; why: string }>;
  decisions: string[];
}

/** Query reasoning/failures/decisions relevant to an objective (spec §8.4 step 1). */
export function replayReasoning(keywords: string[], limit = 20): ReplayResult {
  const reasoning = Reasoning.relevant(keywords, limit);
  const failures = Failures.relevant(keywords, 8).map((f) => ({ approach: f.approach_attempted, why: f.why_it_failed }));
  const decisions = LongTerm.byNamespace('architecture')
    .slice(0, 10)
    .map((m) => m.value_markdown || m.key);
  return { reasoning, failures, decisions };
}

/** Render replay as a structured, human-readable trace (spec §8.4) — no model calls. */
export function renderReplay(result: ReplayResult): string {
  const lines: string[] = [];
  if (result.decisions.length) {
    lines.push('## Established Decisions');
    for (const d of result.decisions) lines.push(`- ${d.split('\n')[0]}`);
  }
  if (result.reasoning.length) {
    lines.push('\n## Relevant Prior Reasoning');
    for (const r of result.reasoning) lines.push(`- [${r.type}] ${r.summary} (confidence ${r.confidence.toFixed(2)})`);
  }
  if (result.failures.length) {
    lines.push('\n## Known Non-Working Approaches');
    for (const f of result.failures) lines.push(`- Tried: ${f.approach} — failed: ${f.why}`);
  }
  return lines.join('\n') || 'No prior reasoning recorded for this objective.';
}
