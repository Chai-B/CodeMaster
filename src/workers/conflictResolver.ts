// ConflictResolver worker (spec §7.6, §12.2) — resolve two contradictory entries.

import { callLlm, firstTag } from './llm.js';
import type { Worker } from './base.js';
import type { ProviderManager } from '../providers/manager.js';
import type { Config } from '../config.js';

export interface ConflictInput {
  sessionId: string;
  a: string; // content A
  b: string; // content B
  context: string;
  manager: ProviderManager;
  cfg: Config;
}

export interface ConflictResolution {
  decision: 'a' | 'b' | 'merge' | 'both';
  merged?: string;
  rationale: string;
}

const SYSTEM = `Two pieces of project knowledge contradict each other. Decide which is correct, or merge them. Respond ONLY with:
<resolution>
<decision>a|b|merge|both</decision>
<rationale>one sentence</rationale>
<merged>if merge: the reconciled content</merged>
</resolution>`;

export const ConflictResolverWorker: Worker<ConflictInput, ConflictResolution> = {
  name: 'ConflictResolver',
  version: '1.0',
  requires_llm: true,
  validate: (i) => ({ ok: !!i.a && !!i.b, error: 'two entries required' }),
  async execute(input) {
    const user = `Context: ${input.context}\n\n## Entry A\n${input.a}\n\n## Entry B\n${input.b}`;
    const { text } = await callLlm(input.manager, input.cfg, {
      system: SYSTEM,
      user,
      sessionId: input.sessionId,
      maxTokens: 600,
    });
    const decision = (firstTag(text, 'decision') ?? 'both').toLowerCase();
    return {
      decision: (['a', 'b', 'merge', 'both'].includes(decision) ? decision : 'both') as ConflictResolution['decision'],
      merged: firstTag(text, 'merged'),
      rationale: firstTag(text, 'rationale') ?? '',
    };
  },
};
