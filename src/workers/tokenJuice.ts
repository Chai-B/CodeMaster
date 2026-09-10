// TokenJuice — deterministic pre-LLM token compression engine.
//
// Inspired by TinyHumans OpenHuman TokenJuice. Compresses raw environment artifacts
// (git diffs, compiler/test failure logs, stack traces, lockfiles, and JSON data)
// BEFORE they reach the prompt compiler, saving up to 80% of tokens deterministically
// with zero LLM calls.

import { estimateTokens } from '../util/tokens.js';
import { parseSource } from '../analysis/treesitter.js';
import { languageOf } from '../analysis/extractors.js';

const LOCKFILE_OR_GENERATED = /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|flake\.lock|\.min\.(js|css)|\.map|\.bundle\.js)$/i;

const RUNTIME_FRAME = /(at\s+(node:internal|.*[\\/]node_modules[\\/]|internal[\\/]).*)|(File\s+".*(site-packages|lib[\\/]python\d\.\d+)[\\/].*)/;

export interface TokenSavings {
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  percentSaved: number;
}

export const TokenJuice = {
  /**
   * Compresses a unified diff by:
   * 1. Summarizing bloated lockfiles and generated/minified assets into a 1-line metadata tag.
   * 2. Trimming excess unchanged context lines in code hunks to `maxContextLines` (default: 2).
   */
  compressDiff(diff: string, maxContextLines = 2): string {
    if (!diff || !diff.trim()) return '';

    const lines = diff.split('\n');
    const out: string[] = [];
    let currentFile = '';
    let isGeneratedOrLock = false;
    let addedCount = 0;
    let removedCount = 0;
    let contextBuffer: string[] = [];

    const flushLockfileSummary = () => {
      if (isGeneratedOrLock && currentFile) {
        out.push(`--- a/${currentFile}`);
        out.push(`+++ b/${currentFile}`);
        out.push(`@@ -1 +1 @@ [TokenJuice: Generated/lockfile diff compacted: +${addedCount} -${removedCount} lines]`);
        addedCount = 0;
        removedCount = 0;
      }
    };

    const flushContextBuffer = (keepTail: boolean) => {
      if (contextBuffer.length <= maxContextLines) {
        out.push(...contextBuffer);
      } else {
        if (keepTail) {
          const tail = contextBuffer.slice(-maxContextLines);
          out.push(`... [${contextBuffer.length - maxContextLines} unchanged lines] ...`);
          out.push(...tail);
        } else {
          const head = contextBuffer.slice(0, maxContextLines);
          out.push(...head);
          out.push(`... [${contextBuffer.length - maxContextLines} unchanged lines] ...`);
        }
      }
      contextBuffer = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      if (line.startsWith('diff --git') || line.startsWith('--- ')) {
        flushLockfileSummary();
        flushContextBuffer(false);

        const m = line.match(/(?:a\/|b\/)(\S+)/);
        if (m && m[1]) {
          currentFile = m[1];
          isGeneratedOrLock = LOCKFILE_OR_GENERATED.test(currentFile);
        }
        if (!isGeneratedOrLock) {
          out.push(line);
        }
        continue;
      }

      if (line.startsWith('+++ ')) {
        if (!isGeneratedOrLock) out.push(line);
        continue;
      }

      if (isGeneratedOrLock) {
        if (line.startsWith('+') && !line.startsWith('+++')) addedCount++;
        else if (line.startsWith('-') && !line.startsWith('---')) removedCount++;
        continue;
      }

      if (line.startsWith('@@ ')) {
        flushContextBuffer(false);
        out.push(line);
        continue;
      }

      if (line.startsWith(' ')) {
        contextBuffer.push(line);
      } else {
        if (contextBuffer.length > 0) {
          flushContextBuffer(true);
        }
        out.push(line);
      }
    }

    flushLockfileSummary();
    flushContextBuffer(false);

    return out.join('\n');
  },

  /**
   * Compresses test/build error traces:
   * 1. Keeps assertion error messages, test failure headers, and root cause lines.
   * 2. Drops internal runtime stack frames (node:internal, site-packages, etc.).
   * 3. Retains repository-local file paths and line references.
   */
  compressTestTrace(trace: string, maxLines = 80): string {
    if (!trace || !trace.trim()) return '';

    const lines = trace.split('\n');
    const out: string[] = [];
    let runtimeFrameCount = 0;

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();

      if (RUNTIME_FRAME.test(line)) {
        runtimeFrameCount++;
        continue;
      }

      if (runtimeFrameCount > 0) {
        out.push(`    ... [${runtimeFrameCount} runtime stack frames omitted]`);
        runtimeFrameCount = 0;
      }

      // Skip progress bars or noisy ANSI lines
      if (line.includes('100%') && line.includes('[=====')) continue;

      out.push(line);
      if (out.length >= maxLines) {
        out.push(`... [${lines.length - maxLines} error lines truncated by TokenJuice]`);
        break;
      }
    }

    if (runtimeFrameCount > 0) {
      out.push(`    ... [${runtimeFrameCount} runtime stack frames omitted]`);
    }

    return out.join('\n');
  },

  /**
   * Deterministically removes null fields, empty arrays, and schema bloat from JSON.
   */
  compressJson(data: unknown): string {
    if (data === null || data === undefined) return '';

    const prune = (v: unknown): unknown => {
      if (v === null || v === undefined) return undefined;
      if (Array.isArray(v)) {
        const cleaned = v.map(prune).filter((x) => x !== undefined);
        return cleaned.length ? cleaned : undefined;
      }
      if (typeof v === 'object') {
        const res: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          const cleaned = prune(val);
          if (cleaned !== undefined) res[k] = cleaned;
        }
        return Object.keys(res).length ? res : undefined;
      }
      return v;
    };

    const cleaned = prune(data);
    return JSON.stringify(cleaned ?? {}, null, 1);
  },

  /**
   * Calculates token reduction metrics between original and compressed representations.
   */
  tokenSavings(original: string, compressed: string): TokenSavings {
    const origTok = estimateTokens(original);
    const compTok = estimateTokens(compressed);
    const saved = Math.max(0, origTok - compTok);
    const pct = origTok > 0 ? Math.round((saved / origTok) * 100) : 0;
    return {
      originalTokens: origTok,
      compressedTokens: compTok,
      savedTokens: saved,
      percentSaved: pct,
    };
  },

  /**
   * Deterministically extracts an outline of signatures and docstrings from source code
   * using tree-sitter, omitting function/method bodies. Falls back to a regex-based
   * signature extraction when tree-sitter is unavailable.
   */
  async compressAstOutline(fileContent: string, filePath: string): Promise<string> {
    const lang = languageOf(filePath);
    if (lang) {
      const ts = await parseSource(fileContent, lang);
      if (ts && ts.symbols && ts.symbols.length > 0) {
        const exported: string[] = [];
        const internal: string[] = [];
        for (const sym of ts.symbols) {
          const line = `${sym.kind} ${sym.name}: ${sym.signature}`;
          if (sym.exported) {
            exported.push(line);
          } else {
            internal.push(line);
          }
        }
        
        const out: string[] = [];
        if (exported.length > 0) {
          out.push('--- Exported ---');
          out.push(...exported);
        }
        if (internal.length > 0) {
          if (exported.length > 0) out.push('');
          out.push('--- Internal ---');
          out.push(...internal);
        }
        return out.join('\n');
      }
    }

    // Fallback: regex extraction
    const lines = fileContent.split('\n');
    const outline: string[] = [];
    const defPattern = /^\s*(export\s+)?(function|class|interface|type|def|fn|pub\s+fn|func)\s+/;
    for (const line of lines) {
      if (defPattern.test(line)) {
        outline.push(line.trim());
      }
    }
    return outline.join('\n');
  },
};
