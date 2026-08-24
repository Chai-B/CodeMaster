// Embedding index (spec §5.2.8) — local onnx MiniLM via @xenova/transformers.
// Vectors stored as float32 BLOBs; cosine similarity in JS. No native build, no API.

import { getRepoDb } from '../storage/db.js';
import { id, now } from '../util/id.js';

import { loadConfig } from '../config.js';

const MODEL = loadConfig().indexing.embeddings.model || 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;

type Extractor = (text: string, opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array }>;

let extractorPromise: Promise<Extractor | null> | null = null;

async function getExtractor(): Promise<Extractor | null> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      try {
        const { pipeline, env } = (await import('@xenova/transformers')) as any;
        env.allowLocalModels = false;
        const pipe = await pipeline('feature-extraction', MODEL);
        return pipe as Extractor;
      } catch {
        return null;
      }
    })();
  }
  return extractorPromise;
}

export async function embavailable(): Promise<boolean> {
  return (await getExtractor()) !== null;
}

export async function embed(text: string): Promise<Float32Array | null> {
  const ex = await getExtractor();
  if (!ex) return null;
  const out = await ex(text.slice(0, 4000), { pooling: 'mean', normalize: true });
  return Float32Array.from(out.data);
}

function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function fromBlob(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot; // vectors are normalized → dot product is cosine
}

/** Embed and store one vector per file (mean of file content). */
export async function indexFileEmbedding(repoPath: string, relPath: string, content: string): Promise<void> {
  const v = await embed(`${relPath}\n${content.slice(0, 4000)}`);
  if (!v) return;
  const db = getRepoDb(repoPath);
  db.prepare("DELETE FROM embeddings WHERE source_type='file' AND source_ref=?").run(relPath);
  db.prepare(
    'INSERT INTO embeddings (id, source_type, source_ref, embedding, embedding_model, created_at) VALUES (?,?,?,?,?,?)',
  ).run(id('emb'), 'file', relPath, toBlob(v), MODEL, now());
}

export interface SimilarFile {
  file: string;
  score: number;
}

export async function findSimilarFiles(repoPath: string, query: string, topK = 8): Promise<SimilarFile[]> {
  const qv = await embed(query);
  if (!qv) return [];
  const db = getRepoDb(repoPath);
  const rows = db
    .prepare("SELECT source_ref, embedding FROM embeddings WHERE source_type='file'")
    .all() as Array<{ source_ref: string; embedding: Buffer }>;
  return rows
    .map((r) => ({ file: r.source_ref, score: cosine(qv, fromBlob(r.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function embeddingCount(repoPath: string): number {
  const r = getRepoDb(repoPath).prepare('SELECT COUNT(*) c FROM embeddings').get() as { c: number };
  return r.c;
}

// ── Per-symbol embeddings (spec §5.2.8) ──────────────────────────────────────
// Embed each function/class/method (name + signature + a body snippet) so a
// prose task description can retrieve the exact symbols to edit even when the
// wording never matches an identifier — precise on large repos where file-level
// vectors are too coarse.
const SYMBOL_KINDS = "('function','class','method','interface','type')";

// Symbol retrieval targets editable source — a source bug is never fixed in a
// test/doc/example, and indexing those only pollutes the top-K (spec §6 roles).
const NON_SOURCE_RE = /(^|\/)(tests?|test|docs?|docs_src|examples?|example|scripts?|__tests__)(\/|$)|(^|\/)(test_|conftest)/i;

export async function indexSymbolEmbeddings(repoPath: string, maxSymbols = 2500): Promise<number> {
  if (!(await embavailable())) return 0;
  const fs = await import('fs');
  const path = await import('path');
  const db = getRepoDb(repoPath);
  db.prepare("DELETE FROM embeddings WHERE source_type='symbol'").run();
  const rows = (
    db
      .prepare(
        `SELECT name, file_path, line_start, signature FROM symbols
         WHERE kind IN ${SYMBOL_KINDS} AND is_exported=1 ORDER BY file_path`,
      )
      .all() as Array<{ name: string; file_path: string; line_start: number; signature: string }>
  )
    .filter((s) => !NON_SOURCE_RE.test(s.file_path))
    .slice(0, maxSymbols);

  const ins = db.prepare(
    'INSERT INTO embeddings (id, source_type, source_ref, embedding, embedding_model, created_at) VALUES (?,?,?,?,?,?)',
  );
  const fileCache = new Map<string, string[]>();
  let n = 0;
  for (const s of rows) {
    let lines = fileCache.get(s.file_path);
    if (!lines) {
      try {
        lines = fs.readFileSync(path.join(repoPath, s.file_path), 'utf8').split('\n');
      } catch {
        lines = [];
      }
      fileCache.set(s.file_path, lines);
    }
    const from = Math.max(0, (s.line_start || 1) - 1);
    const snippet = lines.slice(from, from + 12).join('\n');
    const v = await embed(`${s.file_path} ${s.signature}\n${snippet}`);
    if (!v) continue;
    ins.run(id('emb'), 'symbol', `${s.file_path}#${s.name}`, toBlob(v), MODEL, now());
    n += 1;
  }
  return n;
}

export interface SimilarSymbol {
  file: string;
  symbol: string;
  score: number;
}

export async function findSimilarSymbols(repoPath: string, query: string, topK = 12): Promise<SimilarSymbol[]> {
  const qv = await embed(query);
  if (!qv) return [];
  const db = getRepoDb(repoPath);
  const rows = db
    .prepare("SELECT source_ref, embedding FROM embeddings WHERE source_type='symbol'")
    .all() as Array<{ source_ref: string; embedding: Buffer }>;
  return rows
    .map((r) => {
      const hash = r.source_ref.indexOf('#');
      return {
        file: hash >= 0 ? r.source_ref.slice(0, hash) : r.source_ref,
        symbol: hash >= 0 ? r.source_ref.slice(hash + 1) : r.source_ref,
        score: cosine(qv, fromBlob(r.embedding)),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export { DIM };
