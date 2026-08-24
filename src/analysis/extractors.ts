// Deterministic symbol/import extraction per language (spec §5.2.1).
// Regex-based to avoid native tree-sitter bindings; same factual intent.

export interface ExtractedSymbol {
  name: string;
  kind: 'function' | 'class' | 'variable' | 'type' | 'interface' | 'method';
  line: number;
  signature: string;
  exported: boolean;
}

export interface Extraction {
  symbols: ExtractedSymbol[];
  imports: string[];
}

export const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.swift': 'swift',
};

export function languageOf(filePath: string): string | null {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  return LANG_BY_EXT[ext] ?? null;
}

export function extract(content: string, language: string): Extraction {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return extractTsJs(content);
    case 'python':
      return extractPython(content);
    case 'go':
      return extractGo(content);
    case 'rust':
      return extractRust(content);
    default:
      return extractGeneric(content);
  }
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function extractTsJs(content: string): Extraction {
  const symbols: ExtractedSymbol[] = [];
  const imports: string[] = [];

  const importRe = /import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g;
  for (let m; (m = importRe.exec(content)); ) imports.push(m[1]!);
  const requireRe = /require\(['"]([^'"]+)['"]\)/g;
  for (let m; (m = requireRe.exec(content)); ) imports.push(m[1]!);

  const patterns: Array<[RegExp, ExtractedSymbol['kind']]> = [
    [/(export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*(\([^)]*\))/g, 'function'],
    [/(export\s+)?class\s+([A-Za-z0-9_$]+)/g, 'class'],
    [/(export\s+)?interface\s+([A-Za-z0-9_$]+)/g, 'interface'],
    [/(export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/g, 'type'],
    [/(export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/g, 'function'],
    [/(export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*[:=]/g, 'variable'],
  ];
  for (const [re, kind] of patterns) {
    for (let m; (m = re.exec(content)); ) {
      symbols.push({
        name: m[2]!,
        kind,
        line: lineOf(content, m.index),
        signature: (m[0] ?? '').replace(/\s+/g, ' ').slice(0, 120),
        exported: !!m[1],
      });
    }
  }
  return dedup(symbols, imports);
}

function extractPython(content: string): Extraction {
  const symbols: ExtractedSymbol[] = [];
  const imports: string[] = [];
  const impRe = /^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/gm;
  for (let m; (m = impRe.exec(content)); ) imports.push((m[1] ?? m[2])!);
  const fnRe = /^(\s*)(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*(\([^)]*\))/gm;
  for (let m; (m = fnRe.exec(content)); ) {
    symbols.push({
      name: m[2]!,
      kind: m[1]!.length > 0 ? 'method' : 'function',
      line: lineOf(content, m.index),
      signature: `def ${m[2]}${(m[3] ?? '').replace(/\s+/g, ' ')}`,
      exported: !m[2]!.startsWith('_'),
    });
  }
  const clsRe = /^class\s+([A-Za-z0-9_]+)/gm;
  for (let m; (m = clsRe.exec(content)); ) {
    symbols.push({ name: m[1]!, kind: 'class', line: lineOf(content, m.index), signature: m[0]!, exported: true });
  }
  return dedup(symbols, imports);
}

function extractGo(content: string): Extraction {
  const symbols: ExtractedSymbol[] = [];
  const imports: string[] = [];
  const impRe = /"([^"]+)"/g;
  const importBlock = /import\s*\(([\s\S]*?)\)/.exec(content);
  if (importBlock) for (let m; (m = impRe.exec(importBlock[1]!)); ) imports.push(m[1]!);
  const fnRe = /func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)\s*(\([^)]*\))/g;
  for (let m; (m = fnRe.exec(content)); ) {
    symbols.push({
      name: m[1]!,
      kind: 'function',
      line: lineOf(content, m.index),
      signature: m[0]!.replace(/\s+/g, ' ').slice(0, 120),
      exported: /^[A-Z]/.test(m[1]!),
    });
  }
  const typeRe = /type\s+([A-Za-z0-9_]+)\s+(struct|interface)/g;
  for (let m; (m = typeRe.exec(content)); ) {
    symbols.push({
      name: m[1]!,
      kind: m[2] === 'interface' ? 'interface' : 'type',
      line: lineOf(content, m.index),
      signature: m[0]!,
      exported: /^[A-Z]/.test(m[1]!),
    });
  }
  return dedup(symbols, imports);
}

function extractRust(content: string): Extraction {
  const symbols: ExtractedSymbol[] = [];
  const imports: string[] = [];
  const useRe = /use\s+([A-Za-z0-9_:]+)/g;
  for (let m; (m = useRe.exec(content)); ) imports.push(m[1]!);
  const fnRe = /(pub\s+)?fn\s+([A-Za-z0-9_]+)\s*(\([^)]*\))/g;
  for (let m; (m = fnRe.exec(content)); ) {
    symbols.push({
      name: m[2]!,
      kind: 'function',
      line: lineOf(content, m.index),
      signature: m[0]!.replace(/\s+/g, ' ').slice(0, 120),
      exported: !!m[1],
    });
  }
  const sRe = /(pub\s+)?(struct|enum|trait)\s+([A-Za-z0-9_]+)/g;
  for (let m; (m = sRe.exec(content)); ) {
    symbols.push({
      name: m[3]!,
      kind: m[2] === 'trait' ? 'interface' : 'type',
      line: lineOf(content, m.index),
      signature: m[0]!,
      exported: !!m[1],
    });
  }
  return dedup(symbols, imports);
}

function extractGeneric(content: string): Extraction {
  const symbols: ExtractedSymbol[] = [];
  const re = /(?:function|def|func|class|fn)\s+([A-Za-z0-9_]+)/g;
  for (let m; (m = re.exec(content)); ) {
    symbols.push({ name: m[1]!, kind: 'function', line: lineOf(content, m.index), signature: m[0]!, exported: true });
  }
  return dedup(symbols, []);
}

function dedup(symbols: ExtractedSymbol[], imports: string[]): Extraction {
  const seen = new Set<string>();
  const out: ExtractedSymbol[] = [];
  for (const s of symbols) {
    const k = `${s.name}:${s.line}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return { symbols: out, imports: [...new Set(imports)] };
}
