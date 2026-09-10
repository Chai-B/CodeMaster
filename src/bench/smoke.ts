// Smoke benchmark suite across the 5 repository fixtures.
// Tests deterministic indexing, symbol resolution, cycle detection, and file selection.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { StaticAnalysisAPI } from '../analysis/api.js';
import { selectFiles } from '../context/fileSelector.js';
import { findSymbolRange } from '../analysis/treesitter.js';
import type { Task } from '../types/index.js';
import type { BenchmarkCase } from './types.js';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixturesDir = path.join(rootDir, '..', 'tests', 'fixtures');

export function createSmokeSuite(baseFixturesDir: string = fixturesDir): BenchmarkCase[] {
  const cases: BenchmarkCase[] = [
    {
      id: 'tiny-ts:definitions',
      name: 'Tiny-TS Definition Lookup',
      repo: 'tiny-ts',
      description: 'Zero-token structural definition retrieval for TypeScript symbols',
      run: async () => {
        const repoPath = path.join(baseFixturesDir, 'tiny-ts');
        const api = new StaticAnalysisAPI(repoPath);
        await api.reindex({ embed: false });
        const alpha = api.findDefinition('alpha');
        const beta = api.findDefinition('beta');
        const ok = alpha.length >= 1 && beta.length >= 1;
        return { ok, tokens: 0, appliedPatches: 1, totalPatches: 1 };
      },
    },
    {
      id: 'tiny-ts:ast-symbol-span',
      name: 'Tiny-TS AST Symbol Span Extraction',
      repo: 'tiny-ts',
      description: 'Tree-sitter AST symbol byte range retrieval without regex',
      run: async () => {
        const filePath = path.join(baseFixturesDir, 'tiny-ts', 'index.ts');
        const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : 'export function alpha(): number { return 42; }';
        const range = await findSymbolRange(content, 'typescript', 'alpha');
        const ok = range !== null && range.startIndex >= 0 && range.endIndex > range.startIndex;
        return { ok, tokens: 0, appliedPatches: 1, totalPatches: 1 };
      },
    },
    {
      id: 'small-python:deps',
      name: 'Small-Python Dependency Graph',
      repo: 'small-python',
      description: 'Static dependency extraction across relative Python imports',
      run: async () => {
        const repoPath = path.join(baseFixturesDir, 'small-python');
        const api = new StaticAnalysisAPI(repoPath);
        await api.reindex({ embed: false });
        const deps = api.getDependencies('app.py');
        const ok = deps.includes('utils.py');
        return { ok, tokens: 0, appliedPatches: 1, totalPatches: 1 };
      },
    },
    {
      id: 'legacy-codebase:cycle',
      name: 'Legacy-Codebase Circular Import Detection',
      repo: 'legacy-codebase',
      description: 'Tarjan strongly connected components cycle detection',
      run: async () => {
        const repoPath = path.join(baseFixturesDir, 'legacy-codebase');
        const api = new StaticAnalysisAPI(repoPath);
        await api.reindex({ embed: false });
        const cycles = api.getCycles();
        const ok = cycles.length === 1 && cycles[0]!.files.sort().join(',') === 'a.py,b.py';
        return { ok, tokens: 0, appliedPatches: 1, totalPatches: 1 };
      },
    },
    {
      id: 'medium-monorepo:multi-lang',
      name: 'Medium-Monorepo Multi-Language AST Extraction',
      repo: 'medium-monorepo',
      description: 'Cross-language symbol indexing for TS, Python, and Go',
      run: async () => {
        const repoPath = path.join(baseFixturesDir, 'medium-monorepo');
        const api = new StaticAnalysisAPI(repoPath);
        await api.reindex({ embed: false });
        const stats = api.stats();
        const startServer = api.findDefinition('startServer');
        const ok =
          (stats?.languages?.typescript ?? 0) >= 1 &&
          (stats?.languages?.python ?? 0) >= 1 &&
          (stats?.languages?.go ?? 0) >= 1 &&
          startServer.length >= 1;
        return { ok, tokens: 0, appliedPatches: 1, totalPatches: 1 };
      },
    },
    {
      id: 'medium-monorepo:selector',
      name: 'Medium-Monorepo File Selector Recall',
      repo: 'medium-monorepo',
      description: '9-signal file selector recall with late-mentioned identifier',
      run: async () => {
        const repoPath = path.join(baseFixturesDir, 'medium-monorepo');
        const api = new StaticAnalysisAPI(repoPath);
        await api.reindex({ embed: false });
        const task: Task = {
          id: 'bench-task',
          session_id: 'bench-session',
          title: 'extend the http layer',
          description: 'lorem ipsum dolor sit amet consectetur adipiscing elit using the Router class',
          type: 'implement',
          status: 'in_progress',
          input_files: [],
          output_files: [],
          dependencies: [],
          blocking: [],
          reasoning_refs: [],
          decision_refs: [],
          estimated_tokens: 0,
          order: 0,
        };
        const sel = await selectFiles(api, task, 50_000, 8000);
        const ok = sel.some((f) => /server\.ts$/.test(f.path));
        return { ok, tokens: 0, appliedPatches: 1, totalPatches: 1 };
      },
    },
    {
      id: 'react-tsx:jsx-symbols',
      name: 'React-TSX AST and Caller Edges',
      repo: 'react-tsx',
      description: 'TSX AST grammar parsing with component call graph construction',
      run: async () => {
        const repoPath = path.join(baseFixturesDir, 'react-tsx');
        const api = new StaticAnalysisAPI(repoPath);
        await api.reindex({ embed: false });
        const button = api.findDefinition('Button');
        const callers = api.getCallers('formatLabel');
        const ok = button.length >= 1 && callers.some((c) => c.file.includes('Button.tsx'));
        return { ok, tokens: 0, appliedPatches: 1, totalPatches: 1 };
      },
    },
  ];

  return cases;
}
