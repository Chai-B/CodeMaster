// Wiki bootstrap (spec §9.6) — initial knowledge generation for a new repository.

import fs from 'fs';
import path from 'path';
import { staticAnalysis } from '../analysis/api.js';
import { applyWikiUpdate } from './updater.js';
import { runWorker } from '../workers/base.js';
import { ModuleSummarizerWorker } from '../workers/moduleSummarizer.js';
import { callLlm } from '../workers/llm.js';
import { claudeCliAvailable } from '../providers/anthropic.js';
import { Wiki } from '../storage/wiki.js';
import { bus } from '../events/bus.js';
import fsSync from 'fs';
import type { ProviderManager } from '../providers/manager.js';
import type { Config } from '../config.js';

export interface BootstrapResult {
  modules: number;
  docsImported: number;
  architectureWritten: boolean;
}

const MIN_FILES_FOR_MODULE = 2;
/** Below this much sampled source there is nothing a conventions call can learn. */
const MIN_SOURCE_FOR_CONVENTIONS = 1500;
const DOC_FILES = ['README.md', 'readme.md', 'CONTRIBUTING.md', 'ARCHITECTURE.md'];

export async function bootstrapWiki(
  repoPath: string,
  manager: ProviderManager,
  cfg: Config,
  sessionId: string,
  llm = true,
): Promise<BootstrapResult> {
  const api = staticAnalysis(repoPath);
  if (!api.stats()) await api.reindex();

  bus.emit({ type: 'worker.started', worker: 'WikiBootstrap', detail: 'generating initial knowledge' });
  const map = api.getRepositoryMap();
  let modules = 0;

  // 1. Import existing documentation deterministically.
  let docsImported = 0;
  for (const doc of DOC_FILES) {
    const full = path.join(repoPath, doc);
    if (fs.existsSync(full)) {
      try {
        const content = fs.readFileSync(full, 'utf8').slice(0, 8000);
        applyWikiUpdate({ key: `external_docs/${doc.replace(/\.md$/i, '')}`, content, is_diff: false }, sessionId, cfg.wiki.conflict_strategy);
        docsImported += 1;
      } catch {
        /* skip */
      }
    }
  }

  // 2. Per-module wiki entries (LLM, one call each — spec §9.6). Works with a
  // raw API key OR the authenticated Claude CLI (Pro/Max account creds).
  let architectureWritten = false;
  const llmAvailable =
    llm &&
    (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || claudeCliAvailable());
  if (llmAvailable) {
    const moduleSummaries: string[] = [];
    for (const mod of map.top_level_modules.filter((m) => m.files >= MIN_FILES_FOR_MODULE).slice(0, 12)) {
      try {
        const summary = await runWorker(
          ModuleSummarizerWorker,
          { repoPath, files: mod.key_files, moduleName: mod.name, sessionId, manager, cfg },
          { repoPath, sessionId },
        );
        applyWikiUpdate(
          {
            key: `modules/${mod.name.replace(/[/\\]/g, '_')}`,
            content: `## Summary\n${summary.purpose}\n\n## Responsibilities\n${summary.responsibilities.map((r) => `- ${r}`).join('\n')}\n\n${summary.wiki_markdown}`,
            is_diff: false,
          },
          sessionId,
          cfg.wiki.conflict_strategy,
        );
        moduleSummaries.push(`- **${mod.name}**: ${summary.purpose}`);
        modules += 1;
      } catch {
        /* skip module on failure */
      }
    }

    // 3. Architecture overview.
    if (moduleSummaries.length) {
      applyWikiUpdate(
        {
          key: 'architecture/overview',
          content: `## Summary\nRepository with ${map.total_files} files across ${map.top_level_modules.length} modules.\n\n## Modules\n${moduleSummaries.join('\n')}`,
          is_diff: false,
        },
        sessionId,
        cfg.wiki.conflict_strategy,
      );
      architectureWritten = true;
    }

    // 4. Conventions entry (spec §9) — how to write code that fits this repo.
    // The compiler already injects `conventions`; it was simply empty before.
    try {
      const sampleFiles = map.top_level_modules
        .flatMap((m) => m.key_files)
        .slice(0, 4)
        .map((rel) => {
          try {
            return `// ${rel}\n${fsSync.readFileSync(path.join(repoPath, rel), 'utf8').slice(0, 2500)}`;
          } catch {
            return '';
          }
        })
        .filter(Boolean)
        .join('\n\n');
      // A repository with almost no source has no conventions to extract, and
      // this call is paid in full — one vendor floor — before any work begins.
      // Measured on a two-line repository: 26,084 tokens for "0 modules, 0 docs".
      if (sampleFiles.length < MIN_SOURCE_FOR_CONVENTIONS) {
        bus.emit({ type: 'log', level: 'info', message: 'Skipping conventions: too little source to learn from.' });
        return { modules, docsImported, architectureWritten };
      }
      const { text } = await callLlm(manager, cfg, {
        system:
          'Extract the coding conventions of this repository for future code generation. Output concise markdown bullets covering: language/framework, file & naming conventions, component/module patterns, styling approach, and error-handling style. No preamble.',
        user: `Repository: ${map.total_files} files.\nLanguages: ${JSON.stringify(map.languages)}\n\nRepresentative source:\n${sampleFiles}`,
        sessionId,
        maxTokens: 700,
      });
      if (text.trim()) {
        applyWikiUpdate({ key: 'conventions/overview', content: `## Summary\nProject coding conventions.\n\n## Details\n${text.trim()}`, is_diff: false }, sessionId, cfg.wiki.conflict_strategy);
      }
    } catch {
      /* conventions are best-effort */
    }
  } else {
    // Deterministic fallback overview (no LLM).
    applyWikiUpdate(
      {
        key: 'architecture/overview',
        content: `## Summary\nRepository with ${map.total_files} files.\n\n## Modules\n${map.top_level_modules.slice(0, 12).map((m) => `- **${m.name}** (${m.files} files): ${m.key_files.join(', ')}`).join('\n')}`,
        is_diff: false,
      },
      sessionId,
      cfg.wiki.conflict_strategy,
    );
    architectureWritten = true;
  }

  bus.emit({ type: 'worker.finished', worker: 'WikiBootstrap', detail: `${modules} modules, ${docsImported} docs` });
  return { modules, docsImported, architectureWritten };
}

export function wikiBootstrapped(): boolean {
  return Wiki.get('architecture/overview') !== null;
}
