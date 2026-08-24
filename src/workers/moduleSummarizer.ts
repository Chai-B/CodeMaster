// ModuleSummarizer worker (spec §12.2) — one-time LLM semantic fields for files/modules.

import fs from 'fs';
import path from 'path';
import { callLlm, firstTag } from './llm.js';
import { setFileSemantics } from '../rkg/store.js';
import type { Worker } from './base.js';
import type { ProviderManager } from '../providers/manager.js';
import type { Config } from '../config.js';

export interface SummarizeInput {
  repoPath: string;
  files: string[]; // representative files of a module
  moduleName: string;
  sessionId: string;
  manager: ProviderManager;
  cfg: Config;
}

export interface ModuleSummary {
  purpose: string;
  responsibilities: string[];
  architectural_role: string;
  wiki_markdown: string;
}

const SYSTEM = `You summarize a code module for a knowledge base. Be concise and factual. Respond ONLY with:
<module>
<purpose>one sentence</purpose>
<role>entry point|data model|utility|service|component|configuration</role>
<responsibility>...</responsibility>
<responsibility>...</responsibility>
<wiki>2-4 sentence markdown description</wiki>
</module>`;

export const ModuleSummarizerWorker: Worker<SummarizeInput, ModuleSummary> = {
  name: 'ModuleSummarizer',
  version: '1.0',
  requires_llm: true,
  validate: (i) => ({ ok: i.files.length > 0, error: 'files required' }),
  async execute(input) {
    const snippets = input.files
      .slice(0, 6)
      .map((f) => {
        try {
          const content = fs.readFileSync(path.join(input.repoPath, f), 'utf8').slice(0, 1500);
          return `### ${f}\n${content}`;
        } catch {
          return `### ${f}\n(unreadable)`;
        }
      })
      .join('\n\n');
    const user = `Module: ${input.moduleName}\n\n${snippets}`;
    const { text } = await callLlm(input.manager, input.cfg, {
      system: SYSTEM,
      user,
      sessionId: input.sessionId,
      maxTokens: 800,
    });
    const responsibilities = [...text.matchAll(/<responsibility>([\s\S]*?)<\/responsibility>/g)].map((m) => m[1]!.trim());
    const summary: ModuleSummary = {
      purpose: firstTag(text, 'purpose') ?? input.moduleName,
      responsibilities,
      architectural_role: firstTag(text, 'role') ?? 'component',
      wiki_markdown: firstTag(text, 'wiki') ?? '',
    };
    // persist semantic fields for representative files
    for (const f of input.files.slice(0, 6)) {
      setFileSemantics(input.repoPath, f, summary.purpose, summary.responsibilities, summary.architectural_role);
    }
    return summary;
  },
};
