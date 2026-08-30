// Verifier worker (spec §12.2) — LLM semantic verification of a completed task.

import { callLlm, firstTag } from './llm.js';
import { staticAnalysis } from '../analysis/api.js';
import type { Worker } from './base.js';
import type { ProviderManager } from '../providers/manager.js';
import type { Config } from '../config.js';
import type { Session, Task } from '../types/index.js';
import type { TestResults } from './verify/behavioralVerify.js';

export interface VerifyInput {
  session: Session;
  task: Task;
  manager: ProviderManager;
  cfg: Config;
  testResults?: TestResults;
  /** The files this task actually wrote. Without it the verdict is passed the
   *  whole working tree, so an unrelated edit sitting in the repo decides
   *  whether this task is judged correct. Empty or absent still means the full
   *  diff, which is what the other callers of getWorkingDiff want. */
  files?: string[];
}

export interface VerificationResult {
  verdict: 'pass' | 'fail' | 'partial';
  issues: string[];
  summary: string;
}

const SYSTEM = `You are a code-review verifier. Given a task, its resulting git diff, and deterministic test results, judge whether the task was completed correctly and follows conventions. Deterministic test results are authoritative for behavior — weigh them above your reading of the diff (failing tests => fail, regardless of how the diff looks). Respond ONLY with:
<verification>
<verdict>pass|fail|partial</verdict>
<summary>one sentence</summary>
<issue>...</issue>
</verification>`;

function renderTestResults(t: TestResults): string {
  return `\n\n## Deterministic test results (authoritative)\nframework=${t.framework} ran=${t.ran} passed=${t.passed} failed=${t.failed} guardOk=${t.guardOk} reproUsed=${t.reproUsed}\n${t.output.slice(0, 2000)}`;
}

/**
 * Read a verdict out of the reviewer's reply.
 *
 * A review we could not read is not a review that passed. This used to default
 * to `pass` — twice over — so malformed output was recorded as a clean bill of
 * health, which is the one direction the mistake must not go. `partial` rather
 * than `fail` because `fail` re-executes the whole task for self-correction,
 * and paying for a full retry over a parse error is the wrong trade.
 */
export function parseVerification(text: string): VerificationResult {
  const raw = (firstTag(text, 'verdict') ?? '').trim().toLowerCase();
  const issues = [...text.matchAll(/<issue>([\s\S]*?)<\/issue>/g)].map((m) => m[1]!.trim());
  const summary = firstTag(text, 'summary') ?? '';
  if (raw !== 'pass' && raw !== 'fail' && raw !== 'partial') {
    return {
      verdict: 'partial',
      issues: [...issues, `Verifier response could not be parsed${raw ? ` (verdict "${raw}")` : ' (no verdict)'}`],
      summary: summary || 'Verifier returned no readable verdict; treating as unverified.',
    };
  }
  return { verdict: raw, issues, summary };
}

export const VerifierWorker: Worker<VerifyInput, VerificationResult> = {
  name: 'Verifier',
  version: '1.0',
  requires_llm: true,
  validate: (i) => ({ ok: !!i.task, error: 'task required' }),
  async execute(input) {
    const api = staticAnalysis(input.session.repository.path);
    const diff = await api.getWorkingDiff(input.files);
    const user =
      `## Task\n${input.task.title}\n${input.task.description}\n\n## Resulting diff\n\`\`\`diff\n${diff.slice(0, 12000)}\n\`\`\`` +
      (input.testResults ? renderTestResults(input.testResults) : '');
    const { text } = await callLlm(input.manager, input.cfg, {
      role: 'review',
      system: SYSTEM,
      user,
      sessionId: input.session.id,
      taskId: input.task.id,
      maxTokens: 1024,
    });
    return parseVerification(text);
  },
};
