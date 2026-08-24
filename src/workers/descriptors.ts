// Deterministic worker catalog (spec §12.2) — thin Worker-contract wrappers
// around existing functions so the full catalog is discoverable via /workers
// and every catalog entry honors the Worker<TInput,TOutput> contract (§12.3).

import type { Worker } from './base.js';
import { parseObjective } from './intentParser.js';
import { selectFiles } from '../context/fileSelector.js';
import { readRelevantSections } from '../wiki/reader.js';
import { parseIR } from './outputParser.js';
import { applyPatches } from './patchApplier.js';
import { search as ripgrepSearch } from '../analysis/ripgrep.js';
import { embed } from '../analysis/embeddings.js';
import { staticAnalysis } from '../analysis/api.js';

const ok = () => ({ ok: true });

export const IntentParserWorker: Worker<{ text: string }, ReturnType<typeof parseObjective>> = {
  name: 'IntentParser',
  version: '1.0.0',
  requires_llm: false,
  validate: ok,
  execute: async (input) => parseObjective(input.text),
};

export const StaticIndexerWorker: Worker<{ repoPath: string; file?: string }, unknown> = {
  name: 'StaticIndexer',
  version: '1.0.0',
  requires_llm: false,
  validate: ok,
  execute: async (input) => {
    const api = staticAnalysis(input.repoPath);
    return input.file ? api.indexFile(input.file) : api.reindex();
  },
};

export const FileSelectorWorker: Worker<
  { repoPath: string; task: Parameters<typeof selectFiles>[1]; budget: number; threshold: number },
  Awaited<ReturnType<typeof selectFiles>>
> = {
  name: 'FileSelector',
  version: '1.0.0',
  requires_llm: false,
  validate: ok,
  execute: async (input) => selectFiles(staticAnalysis(input.repoPath), input.task, input.budget, input.threshold),
};

export const WikiReaderWorker: Worker<
  { taskType: Parameters<typeof readRelevantSections>[0]; keywords: string[]; limit?: number },
  ReturnType<typeof readRelevantSections>
> = {
  name: 'WikiReader',
  version: '1.0.0',
  requires_llm: false,
  validate: ok,
  execute: async (input) => readRelevantSections(input.taskType, input.keywords, input.limit ?? 8),
};

export const OutputParserWorker: Worker<
  { raw: string; sessionId: string; taskId: string; producedBy: Parameters<typeof parseIR>[3] },
  ReturnType<typeof parseIR>
> = {
  name: 'OutputParser',
  version: '1.0.0',
  requires_llm: false,
  validate: ok,
  execute: async (input) => parseIR(input.raw, input.sessionId, input.taskId, input.producedBy),
};

export const PatchApplierWorker: Worker<
  { repoPath: string; patches: Parameters<typeof applyPatches>[1]; newFiles: Parameters<typeof applyPatches>[2] },
  ReturnType<typeof applyPatches>
> = {
  name: 'PatchApplier',
  version: '1.0.0',
  requires_llm: false,
  validate: ok,
  execute: async (input) => applyPatches(input.repoPath, input.patches, input.newFiles),
};

export const RipgrepWorker: Worker<
  { repoPath: string; pattern: string; opts?: Parameters<typeof ripgrepSearch>[2] },
  ReturnType<typeof ripgrepSearch>
> = {
  name: 'RipgrepWorker',
  version: '1.0.0',
  requires_llm: false,
  validate: ok,
  execute: async (input) => ripgrepSearch(input.repoPath, input.pattern, input.opts),
};

export const EmbeddingWorker: Worker<{ text: string }, Float32Array | null> = {
  name: 'EmbeddingWorker',
  version: '1.0.0',
  requires_llm: false,
  validate: ok,
  execute: async (input) => embed(input.text),
};

export const DETERMINISTIC_WORKERS: Worker<any, any>[] = [
  IntentParserWorker,
  StaticIndexerWorker,
  FileSelectorWorker,
  WikiReaderWorker,
  OutputParserWorker,
  PatchApplierWorker,
  RipgrepWorker,
  EmbeddingWorker,
];
