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

export const VerifierWorker: Worker<VerifyInput, VerificationResult> = {
  name: 'Verifier',
  version: '1.0',
  requires_llm: true,
  validate: (i) => ({ ok: !!i.task, error: 'task required' }),
  async execute(input) {
    const api = staticAnalysis(input.session.repository.path);
    const diff = await api.getWorkingDiff();
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
    const verdict = (firstTag(text, 'verdict') ?? 'pass').toLowerCase();
    const issues = [...text.matchAll(/<issue>([\s\S]*?)<\/issue>/g)].map((m) => m[1]!.trim());
    return {
      verdict: (['pass', 'fail', 'partial'].includes(verdict) ? verdict : 'pass') as VerificationResult['verdict'],
      issues,
      summary: firstTag(text, 'summary') ?? '',
    };
  },
};
