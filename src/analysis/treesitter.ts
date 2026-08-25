// Tree-sitter parsing via web-tree-sitter WASM grammars (spec §5.2.1).
// Produces the same Extraction shape as extractors.ts, plus call edges.
// Falls back to the regex extractor when a grammar is unavailable or parsing fails.

import { createRequire } from 'module';
import path from 'path';
import { extract as regexExtract, pythonFromImport, type ExtractedSymbol } from './extractors.js';

const require = createRequire(import.meta.url);
// web-tree-sitter 0.20.x is a CommonJS default export (Parser class with static init/Language).
const Parser = require('web-tree-sitter') as any;
type Language = any;
type Query = any;

export interface CallEdge {
  caller: string; // enclosing function name ('<module>' if top-level)
  callee: string;
  line: number;
}

export interface TsExtraction {
  symbols: ExtractedSymbol[];
  imports: string[];
  calls: CallEdge[];
}

const GRAMMAR_FILE: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  // NOTE: Swift is supported via the regex extractor (extractors.ts). The bundled
  // tree-sitter-swift.wasm is incompatible with web-tree-sitter 0.20.x (hard WASM
  // abort), so per spec §5.2.1 it belongs as a grammar plugin, not a core grammar.
};

// kind capture name → symbol kind; @def captures the enclosing declaration node.
const QUERIES: Record<string, string> = {
  typescript: `
    (function_declaration name: (identifier) @function) @def
    (method_definition name: (property_identifier) @method) @def
    (class_declaration name: (type_identifier) @class) @def
    (interface_declaration name: (type_identifier) @interface) @def
    (type_alias_declaration name: (type_identifier) @type) @def
    (variable_declarator name: (identifier) @variable) @def
    (import_statement source: (string) @import)
    (call_expression function: (identifier) @call)
    (call_expression function: (member_expression property: (property_identifier) @call))
  `,
  python: `
    (function_definition name: (identifier) @function) @def
    (class_definition name: (identifier) @class) @def
    (import_statement name: (dotted_name) @import)
    (import_from_statement) @import_from
    (call function: (identifier) @call)
    (call function: (attribute attribute: (identifier) @call))
  `,
  go: `
    (function_declaration name: (identifier) @function) @def
    (method_declaration name: (field_identifier) @method) @def
    (type_spec name: (type_identifier) @type) @def
    (import_spec path: (interpreted_string_literal) @import)
    (call_expression function: (identifier) @call)
    (call_expression function: (selector_expression field: (field_identifier) @call))
  `,
  rust: `
    (function_item name: (identifier) @function) @def
    (struct_item name: (type_identifier) @class) @def
    (enum_item name: (type_identifier) @type) @def
    (trait_item name: (type_identifier) @interface) @def
    (use_declaration) @import_use
    (call_expression function: (identifier) @call)
  `,
  java: `
    (method_declaration name: (identifier) @method) @def
    (class_declaration name: (identifier) @class) @def
    (interface_declaration name: (identifier) @interface) @def
    (import_declaration (scoped_identifier) @import)
    (method_invocation name: (identifier) @call)
  `,
  ruby: `
    (method name: (identifier) @method) @def
    (class name: (constant) @class) @def
    (module name: (constant) @class) @def
    (call method: (identifier) @call)
  `,
  c: `
    (function_definition declarator: (function_declarator declarator: (identifier) @function)) @def
    (struct_specifier name: (type_identifier) @class) @def
    (preproc_include path: (_) @import)
    (call_expression function: (identifier) @call)
  `,
  cpp: `
    (function_definition declarator: (function_declarator declarator: (identifier) @function)) @def
    (class_specifier name: (type_identifier) @class) @def
    (struct_specifier name: (type_identifier) @class) @def
    (preproc_include path: (_) @import)
    (call_expression function: (identifier) @call)
  `,
};
QUERIES.tsx = QUERIES.typescript!;
QUERIES.javascript = QUERIES.typescript!;

let initialized = false;
const languages = new Map<string, Language>();
const compiledQueries = new Map<string, Query>();
let parser: any = null;

function grammarDir(): string {
  return path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
}

export async function initTreeSitter(): Promise<boolean> {
  if (initialized) return true;
  try {
    await Parser.init();
    parser = new Parser();
    initialized = true;
    return true;
  } catch {
    return false;
  }
}

async function loadLanguage(lang: string): Promise<Language | null> {
  if (languages.has(lang)) return languages.get(lang)!;
  const file = GRAMMAR_FILE[lang];
  if (!file) return null;
  try {
    const wasm = path.join(grammarDir(), file);
    const language = await Parser.Language.load(wasm);
    languages.set(lang, language);
    return language;
  } catch {
    return null;
  }
}

export async function treeSitterAvailable(lang: string): Promise<boolean> {
  if (!(await initTreeSitter())) return false;
  return (await loadLanguage(lang)) !== null;
}

export async function parseSource(content: string, lang: string): Promise<TsExtraction | null> {
  if (!(await initTreeSitter()) || !parser) return null;
  const language = await loadLanguage(lang);
  if (!language) return null;
  const querySrc = QUERIES[lang];
  if (!querySrc) return null;

  try {
    parser.setLanguage(language);
    const tree = parser.parse(content);
    if (!tree) return null;

    let query = compiledQueries.get(lang);
    if (!query) {
      query = language.query(querySrc);
      compiledQueries.set(lang, query);
    }

    const symbols: ExtractedSymbol[] = [];
    const imports: string[] = [];
    const calls: CallEdge[] = [];

    for (const match of query.matches(tree.rootNode)) {
      const byName: Record<string, any> = {};
      for (const c of match.captures) byName[c.name] = c.node;

      // imports
      if (byName.import) {
        imports.push(cleanImport(byName.import.text));
        continue;
      }
      // `module_name` alone cannot see a relative import: `from . import x`
      // parses as a relative_import node, so the whole statement is captured
      // and its import list expanded here.
      if (byName.import_from) {
        imports.push(...pythonFromImport(byName.import_from.text));
        continue;
      }
      if (byName.import_use) {
        const t = byName.import_use.text.replace(/^use\s+/, '').replace(/;$/, '').trim();
        imports.push(t.split('::').slice(0, 2).join('::'));
        continue;
      }
      // calls
      if (byName.call) {
        calls.push({
          caller: enclosingName(byName.call) ?? '<module>',
          callee: byName.call.text,
          line: byName.call.startPosition.row + 1,
        });
        continue;
      }
      // symbol definitions
      const kindKey = Object.keys(byName).find((k) => k !== 'def' && k !== 'call' && k !== 'import');
      if (kindKey && byName[kindKey]) {
        const nameNode = byName[kindKey]!;
        const defNode = byName.def ?? nameNode;
        symbols.push({
          name: nameNode.text,
          kind: kindKey as ExtractedSymbol['kind'],
          line: nameNode.startPosition.row + 1,
          signature: defNode.text.split('\n')[0]!.slice(0, 120),
          exported: isExported(lang, nameNode, defNode),
        });
      }
    }

    tree.delete();
    return { symbols: dedup(symbols), imports: [...new Set(imports)], calls };
  } catch {
    return null;
  }
}

// Use tree-sitter when possible; fall back to regex (which yields no calls).
export async function extractWithFallback(content: string, lang: string): Promise<TsExtraction> {
  const ts = await parseSource(content, lang);
  if (ts) return ts;
  const r = regexExtract(content, lang);
  return { symbols: r.symbols, imports: r.imports, calls: [] };
}

function cleanImport(text: string): string {
  return text.replace(/^['"]|['"]$/g, '').replace(/^<|>$/g, '').trim();
}

function enclosingName(node: { parent: unknown }): string | null {
  let cur = node as any;
  while (cur) {
    const t = cur.type;
    if (t === 'function_declaration' || t === 'function_definition' || t === 'method_definition' ||
        t === 'method_declaration' || t === 'function_item' || t === 'method' || t === 'arrow_function') {
      const nameChild = cur.childForFieldName?.('name');
      if (nameChild) return nameChild.text;
    }
    cur = cur.parent ?? null;
  }
  return null;
}

function isExported(lang: string, nameNode: any, defNode: any): boolean {
  const name = nameNode.text as string;
  if (lang === 'python') return !name.startsWith('_');
  if (lang === 'go' || lang === 'ruby') return /^[A-Z]/.test(name);
  if (lang === 'rust') {
    let cur = defNode;
    while (cur) {
      if (typeof cur.text === 'string' && cur.text.startsWith('pub ')) return true;
      cur = cur.parent;
      if (cur && (cur.type === 'source_file')) break;
    }
    return false;
  }
  // ts/js/java: look for an export ancestor
  let cur = defNode?.parent;
  let hops = 0;
  while (cur && hops++ < 4) {
    if (typeof cur.type === 'string' && cur.type.includes('export')) return true;
    cur = cur.parent;
  }
  return false;
}

function dedup(symbols: ExtractedSymbol[]): ExtractedSymbol[] {
  const seen = new Set<string>();
  const out: ExtractedSymbol[] = [];
  for (const s of symbols) {
    const k = `${s.name}:${s.line}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}
