// MCP server (spec §7 phase 7). CodeMaster's whole claim is that a coding agent
// should be handed the context it needs instead of spending tokens discovering
// it, and should not re-derive reasoning the repository already holds. This
// exposes exactly that to any MCP-speaking agent — Claude Code, Codex, an
// editor — over stdio.
//
// The transport is newline-delimited JSON-RPC 2.0, which is all MCP stdio is,
// so this adds no dependency.

import fs from 'fs';
import path from 'path';
import { setActiveRepo } from './config.js';
import { loadConfig } from './config.js';
import { compileContext } from './context/compiler.js';
import { staticAnalysis } from './analysis/api.js';
import { Reasoning, Failures } from './storage/reasoning.js';
import { id, now } from './util/id.js';
import type { Session, Task, TaskType } from './types/index.js';

const TASK_TYPES: TaskType[] = ['plan', 'implement', 'test', 'review', 'verify', 'refactor', 'debug'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, repo: string) => Promise<string> | string;
}

function str(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key];
  return typeof v === 'string' ? v : fallback;
}
function strList(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * An in-memory session and task, good enough to compile against. Nothing is
 * persisted: an external agent asking for context must not create sessions in
 * the user's project.
 */
function ephemeral(repo: string, objective: string, type: TaskType, files: string[]): { session: Session; task: Task } {
  const session = {
    id: 'mcp',
    created_at: now(),
    updated_at: now(),
    status: 'active',
    objective,
    repository: { path: repo, commit: 'mcp' },
    progress: { total: 1, completed: 0, failed: 0 },
    constraints: [],
    open_questions: [],
    working_files: [],
    decisions: [],
    provider_history: [],
    checkpoints: [],
    token_usage: { total: 0, input: 0, output: 0, cost_usd: 0 },
    metadata: {},
  } as unknown as Session;
  const task = {
    id: 'mcp-task',
    session_id: 'mcp',
    title: objective.slice(0, 80),
    description: objective,
    type,
    status: 'in_progress',
    input_files: files.map((p) => ({ path: p })),
    output_files: [],
    dependencies: [],
    blocking: [],
    reasoning_refs: [],
    decision_refs: [],
    estimated_tokens: 0,
    order: 0,
  } as unknown as Task;
  return { session, task };
}

const TOOLS: ToolDef[] = [
  {
    name: 'compile_context',
    description:
      'Deterministically compile everything needed to work on an objective in this repository: ' +
      'relevant files, repository map, architecture, conventions, prior reasoning and known failures. ' +
      'No LLM is involved and nothing is persisted. Use this instead of exploring the repository by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'What you are trying to do.' },
        task_type: { type: 'string', enum: TASK_TYPES, description: 'Shapes the context budget profile.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files you already know are involved.' },
        tier: { type: 'number', description: 'Budget rung: 0 ≈ 24k tokens, 1 ≈ 64k, 2 ≈ 160k. Start at 0.' },
      },
      required: ['objective'],
    },
    async run(args, repo) {
      const type = TASK_TYPES.includes(str(args, 'task_type') as TaskType)
        ? (str(args, 'task_type') as TaskType)
        : 'implement';
      const { session, task } = ephemeral(repo, str(args, 'objective'), type, strList(args, 'files'));
      const cfg = loadConfig();
      const tier = typeof args.tier === 'number' ? args.tier : 0;
      const compiled = await compileContext(session, task, {
        maxContextTokens: cfg.context.max_context_tokens,
        fileCompressionThreshold: cfg.context.file_compression_threshold,
        tier,
      });
      return compiled.body;
    },
  },
  {
    name: 'relevant_files',
    description:
      'Rank the files that matter for an objective, cheapest possible answer: paths and scores only, no contents. ' +
      'Use it to decide what to read rather than searching the repository.',
    inputSchema: {
      type: 'object',
      properties: { objective: { type: 'string' }, limit: { type: 'number' } },
      required: ['objective'],
    },
    async run(args, repo) {
      const { selectFiles } = await import('./context/fileSelector.js');
      const cfg = loadConfig();
      const { task } = ephemeral(repo, str(args, 'objective'), 'implement', []);
      const limit = typeof args.limit === 'number' ? args.limit : 15;
      const files = await selectFiles(staticAnalysis(repo), task, 200_000, cfg.context.file_compression_threshold);
      const lines = files.slice(0, limit).map((f) => `${f.score.toFixed(2)}  ${f.path}`);
      return lines.join('\n') || 'No files matched. Is the repository indexed?';
    },
  },
  {
    name: 'prior_reasoning',
    description:
      'Decisions, trade-offs and non-working approaches this repository has already recorded — by query, ' +
      'by the files being touched, or both. Read this before deciding anything: it is how the same reasoning ' +
      'stops being paid for twice.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
      },
    },
    run(args) {
      const query = str(args, 'query');
      const files = strList(args, 'files');
      const reasoning = files.length ? Reasoning.byAffectedFiles(files) : query ? Reasoning.search(query) : [];
      const failures = files.length
        ? Failures.byAffectedFiles(files)
        : query
          ? Failures.relevant(query.split(/\s+/).filter(Boolean))
          : [];
      const out: string[] = [];
      if (reasoning.length) {
        out.push('## Prior reasoning');
        for (const r of reasoning) out.push(`- [${r.type}] ${r.summary} (confidence ${r.confidence.toFixed(2)})`);
      }
      if (failures.length) {
        out.push('## Approaches that did not work');
        for (const f of failures) out.push(`- ${f.approach_attempted} — ${f.why_it_failed}`);
      }
      return out.join('\n') || 'Nothing recorded for this yet.';
    },
  },
  {
    name: 'record_reasoning',
    description:
      'Persist a decision or finding so the next agent — or the next session — does not re-derive it. ' +
      'Keyed to the files it concerns, not to a conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One line: what was decided or found.' },
        detail: { type: 'string', description: 'Why. The reasoning that produced it.' },
        files: { type: 'array', items: { type: 'string' } },
        type: { type: 'string', enum: ['decision', 'analysis', 'discovery', 'constraint'] },
      },
      required: ['summary'],
    },
    run(args) {
      const summary = str(args, 'summary');
      if (!summary) return 'summary is required.';
      Reasoning.insert({
        id: id('reasoning'),
        session_id: 'mcp',
        type: (str(args, 'type', 'analysis') as 'analysis'),
        summary,
        detail: str(args, 'detail'),
        affected_files: strList(args, 'files').map((p) => ({ path: p })),
        confidence: 0.7,
        created_at: now(),
        reference_count: 0,
        keywords: [],
      } as never);
      return `Recorded: ${summary}`;
    },
  },
  {
    name: 'repository_map',
    description: 'The repository\'s structure and its most important modules, compiled from the index — not a file listing.',
    inputSchema: { type: 'object', properties: { depth: { type: 'number' } } },
    run(args, repo) {
      const depth = typeof args.depth === 'number' ? args.depth : 12;
      const api = staticAnalysis(repo);
      // An unindexed repository renders an empty-but-valid map, which reads as
      // "this project has no code" rather than "ask again after indexing".
      if (!api.stats()) return 'Repository not indexed yet. Run `codemaster` in it once, or /reindex.';
      return api.renderRepositoryMap(depth);
    },
  },
];

// ── JSON-RPC over stdio ─────────────────────────────────────────────────────

interface Rpc {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

async function handle(req: Rpc, repo: string): Promise<void> {
  // Notifications carry no id and get no reply.
  const reply = (result: Record<string, unknown>): void => {
    if (req.id !== undefined) send({ id: req.id, result });
  };

  switch (req.method) {
    case 'initialize':
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'codemaster', version: '0.1.0' },
      });
    case 'tools/list':
      return reply({
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case 'tools/call': {
      const name = String(req.params?.name ?? '');
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        if (req.id !== undefined) send({ id: req.id, error: { code: -32601, message: `Unknown tool: ${name}` } });
        return;
      }
      try {
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const text = await tool.run(args, repo);
        return reply({ content: [{ type: 'text', text }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `Failed: ${String(e)}` }], isError: true });
      }
    }
    case 'ping':
      return reply({});
    default:
      if (req.id !== undefined) send({ id: req.id, error: { code: -32601, message: `Unknown method: ${req.method}` } });
  }
}

export async function runMcpServer(repoPath: string): Promise<void> {
  const repo = path.resolve(repoPath);
  if (!fs.existsSync(repo)) throw new Error(`No such directory: ${repo}`);
  setActiveRepo(repo);

  let buffer = '';
  process.stdin.setEncoding('utf8');
  // Requests are handled in arrival order; MCP clients may pipeline, and a
  // compile that overtook the ping before it would report against a half-set
  // repository.
  let chain: Promise<void> = Promise.resolve();

  for await (const chunk of process.stdin) {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let req: Rpc;
      try {
        req = JSON.parse(line) as Rpc;
      } catch {
        continue; // A malformed line is not worth killing the server for.
      }
      chain = chain.then(() => handle(req, repo)).catch(() => undefined);
    }
  }
  await chain;
}

export { TOOLS as MCP_TOOLS };
