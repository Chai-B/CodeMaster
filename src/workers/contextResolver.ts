// ContextResolver — answers model <context_request> blocks deterministically (spec §5.4, §14.1).
// Zero LLM tokens spent: answers via StaticAnalysisAPI, ripgrep, and local AST index.

import fs from 'fs';
import path from 'path';
import { StaticAnalysisAPI } from '../analysis/api.js';
import { search as rgSearch } from '../analysis/ripgrep.js';
import type { ContextRequest } from '../types/ir.js';

export interface ContextResolutionResult {
  xml: string;
  resolvedCount: number;
  missCount: number;
}

function resolveInRepo(repoPath: string, rel: string): string | null {
  const root = path.resolve(repoPath);
  const full = path.resolve(root, rel);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function resolveContextRequests(
  repoPath: string,
  requests: ContextRequest[],
): Promise<ContextResolutionResult> {
  const analysis = new StaticAnalysisAPI(repoPath);
  const out: string[] = ['<context_response>'];
  let resolvedCount = 0;
  let missCount = 0;

  for (const req of requests) {
    switch (req.type) {
      case 'symbol': {
        const defs = analysis.findDefinition(req.target);
        if (defs.length > 0) {
          resolvedCount++;
          for (const d of defs) {
            out.push(`  <symbol name="${escapeXml(req.target)}" status="found" file="${escapeXml(d.file)}" line="${d.line}">`);
            if (d.signature) {
              out.push(`    <signature>${escapeXml(d.signature)}</signature>`);
            }
            // Include surrounding code snippet if file exists
            const full = resolveInRepo(repoPath, d.file);
            if (full && fs.existsSync(full)) {
              try {
                const lines = fs.readFileSync(full, 'utf8').split('\n');
                const start = Math.max(0, d.line - 1);
                const end = Math.min(lines.length, start + 35);
                const snippet = lines.slice(start, end).join('\n');
                out.push(`    <snippet line_start="${start + 1}" line_end="${end}">`);
                out.push(escapeXml(snippet));
                out.push(`    </snippet>`);
              } catch {
                /* snippet reading is best effort */
              }
            }
            out.push(`  </symbol>`);
          }
        } else {
          // Check fuzzy symbols
          const fuzzy = analysis.fuzzySymbols(req.target, 5);
          if (fuzzy.length > 0) {
            resolvedCount++;
            out.push(`  <symbol name="${escapeXml(req.target)}" status="fuzzy_matches">`);
            for (const f of fuzzy) {
              out.push(`    <match name="${escapeXml(f.name)}" file="${escapeXml(f.file)}" line="${f.line}" signature="${escapeXml(f.signature || '')}" />`);
            }
            out.push(`  </symbol>`);
          } else {
            missCount++;
            out.push(`  <symbol name="${escapeXml(req.target)}" status="not_found" />`);
          }
        }
        break;
      }

      case 'callers_of': {
        const callers = analysis.getCallers(req.target);
        if (callers.length > 0) {
          resolvedCount++;
          out.push(`  <callers_of symbol="${escapeXml(req.target)}" status="found">`);
          for (const c of callers) {
            out.push(`    <caller name="${escapeXml(c.name)}" file="${escapeXml(c.file)}" line="${c.line}" />`);
          }
          out.push(`  </callers_of>`);
        } else {
          // Fallback to text references
          const refs = analysis.findReferences(req.target).slice(0, 10);
          if (refs.length > 0) {
            resolvedCount++;
            out.push(`  <callers_of symbol="${escapeXml(req.target)}" status="text_references">`);
            for (const r of refs) {
              out.push(`    <reference file="${escapeXml(r.file)}" line="${r.line}">${escapeXml(r.text.trim())}</reference>`);
            }
            out.push(`  </callers_of>`);
          } else {
            missCount++;
            out.push(`  <callers_of symbol="${escapeXml(req.target)}" status="none_found" />`);
          }
        }
        break;
      }

      case 'file': {
        const full = resolveInRepo(repoPath, req.target);
        if (!full || !fs.existsSync(full)) {
          missCount++;
          out.push(`  <file path="${escapeXml(req.target)}" status="not_found" />`);
          break;
        }

        try {
          const content = fs.readFileSync(full, 'utf8');
          const lines = content.split('\n');
          let sliceLines = lines;
          let sliceAttr = '';

          if (req.slice) {
            const parts = req.slice.split(/[:-]/);
            const startLine = Math.max(1, parseInt(parts[0] || '1', 10));
            const endLine = Math.min(lines.length, parseInt(parts[1] || String(lines.length), 10));
            sliceLines = lines.slice(startLine - 1, endLine);
            sliceAttr = ` slice="${startLine}-${endLine}"`;
          }

          resolvedCount++;
          out.push(`  <file path="${escapeXml(req.target)}"${sliceAttr} status="found">`);
          out.push(escapeXml(sliceLines.join('\n')));
          out.push(`  </file>`);
        } catch (e) {
          missCount++;
          out.push(`  <file path="${escapeXml(req.target)}" status="error" reason="${escapeXml(String(e))}" />`);
        }
        break;
      }

      case 'grep': {
        try {
          const hits = rgSearch(repoPath, req.target, { maxResults: 15 });
          if (hits.length > 0) {
            resolvedCount++;
            out.push(`  <grep pattern="${escapeXml(req.target)}" count="${hits.length}">`);
            for (const h of hits) {
              out.push(`    <match file="${escapeXml(h.file)}" line="${h.line}">${escapeXml(h.text.trim())}</match>`);
            }
            out.push(`  </grep>`);
          } else {
            missCount++;
            out.push(`  <grep pattern="${escapeXml(req.target)}" count="0" status="no_matches" />`);
          }
        } catch (e) {
          missCount++;
          out.push(`  <grep pattern="${escapeXml(req.target)}" status="error" reason="${escapeXml(String(e))}" />`);
        }
        break;
      }
    }
  }

  out.push('</context_response>');
  return {
    xml: out.join('\n'),
    resolvedCount,
    missCount,
  };
}
