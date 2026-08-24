// OpenAI-compatible proxy (spec §7 phase 7). Anything that already speaks the
// chat-completions API — an editor, a script, another agent framework — can
// point at this and get the two things CodeMaster adds: deterministic context
// for the repository, and failover across every provider the user has, with
// the session's reasoning carried across a vendor switch.
//
// Uses node:http, so it adds no dependency.

import http from 'http';
import path from 'path';
import { loadConfig, setActiveRepo } from './config.js';
import { compileContext } from './context/compiler.js';
import { ProviderManager } from './providers/manager.js';
import { Tokens } from './storage/tokens.js';
import { now } from './util/id.js';
import type { CompiledPrompt, Session, Task } from './types/index.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  /** CodeMaster extension. `context: false` passes the prompt through untouched. */
  codemaster?: { context?: boolean; task_type?: string; tier?: number };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 8 * 1024 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * The repository context for this prompt, compiled deterministically — the
 * caller's own message stays the task, and everything the repository knows
 * about it is prepended.
 */
async function contextFor(repo: string, objective: string, taskType: string, tier: number): Promise<CompiledPrompt> {
  const cfg = loadConfig();
  const session = {
    id: 'proxy', created_at: now(), updated_at: now(), status: 'active', objective,
    repository: { path: repo, commit: 'proxy' },
    progress: { total: 1, completed: 0, failed: 0 },
    constraints: [], open_questions: [], working_files: [], decisions: [],
    provider_history: [], checkpoints: [],
    token_usage: { total: 0, input: 0, output: 0, cost_usd: 0 }, metadata: {},
  } as unknown as Session;
  const task = {
    id: 'proxy-task', session_id: 'proxy', title: objective.slice(0, 80), description: objective,
    type: taskType, status: 'in_progress', input_files: [], output_files: [],
    dependencies: [], blocking: [], reasoning_refs: [], decision_refs: [],
    estimated_tokens: 0, order: 0,
  } as unknown as Task;
  return compileContext(session, task, {
    maxContextTokens: cfg.context.max_context_tokens,
    fileCompressionThreshold: cfg.context.file_compression_threshold,
    tier,
  });
}

export async function runProxy(repoPath: string, port: number): Promise<http.Server> {
  const repo = path.resolve(repoPath);
  setActiveRepo(repo);
  const cfg = loadConfig();
  const manager = new ProviderManager(cfg);

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = (req.url ?? '').split('?')[0];

      if (req.method === 'GET' && url === '/v1/models') {
        return json(res, 200, {
          object: 'list',
          data: manager.listModels().map((m) => ({ id: m.id, object: 'model', owned_by: 'codemaster' })),
        });
      }

      if (req.method !== 'POST' || url !== '/v1/chat/completions') {
        return json(res, 404, { error: { message: `Not found: ${req.method} ${url}`, type: 'invalid_request_error' } });
      }

      let body: ChatRequest;
      try {
        body = JSON.parse(await readBody(req)) as ChatRequest;
      } catch (e) {
        return json(res, 400, { error: { message: String(e), type: 'invalid_request_error' } });
      }

      const messages = body.messages ?? [];
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (!lastUser) {
        return json(res, 400, { error: { message: 'No user message', type: 'invalid_request_error' } });
      }
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');

      try {
        const withContext = body.codemaster?.context !== false;
        // Earlier turns are the caller's conversation, not the repository's
        // state, so they are passed through verbatim below the context.
        const history = messages
          .filter((m) => m.role !== 'system' && m !== lastUser)
          .map((m) => `${m.role}: ${m.content}`)
          .join('\n\n');

        const compiled = withContext
          ? await contextFor(repo, lastUser.content, body.codemaster?.task_type ?? 'implement', body.codemaster?.tier ?? 0)
          : null;

        const prompt: CompiledPrompt = {
          session_id: 'proxy',
          task_id: 'proxy-task',
          task_type: (body.codemaster?.task_type ?? 'implement') as CompiledPrompt['task_type'],
          compiled_at: now(),
          system: [compiled?.system, system].filter(Boolean).join('\n\n'),
          components: compiled?.components ?? [],
          body: [compiled?.body, history, lastUser.content].filter(Boolean).join('\n\n'),
          total_tokens: compiled?.total_tokens ?? 0,
          max_tokens: cfg.context.max_context_tokens,
          included: compiled?.included ?? [],
          omitted: compiled?.omitted ?? [],
        };

        const { sel, response } = await manager.invokeWithFailover(prompt, cfg.context.max_context_tokens);
        Tokens.record({
          session_id: 'proxy',
          task_id: 'proxy-task',
          provider_id: sel.adapter.provider_id,
          account_id: sel.account.id,
          model_id: sel.model,
          usage: response.usage,
          cost_usd: manager.costOf(sel.spec, response.usage.input_tokens, response.usage.output_tokens),
          components: prompt.included,
        });

        const id = `chatcmpl-${Date.now().toString(36)}`;
        const usage = {
          prompt_tokens: response.usage.input_tokens,
          completion_tokens: response.usage.output_tokens,
          total_tokens: response.usage.total_tokens,
        };

        // The adapters are not streaming, so a streaming client gets one content
        // chunk and the terminator rather than a fabricated token-by-token feed.
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          const chunk = {
            id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: sel.model,
            choices: [{ index: 0, delta: { role: 'assistant', content: response.text }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }

        return json(res, 200, {
          id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: sel.model,
          choices: [{ index: 0, message: { role: 'assistant', content: response.text }, finish_reason: 'stop' }],
          usage,
        });
      } catch (e) {
        return json(res, 502, { error: { message: e instanceof Error ? e.message : String(e), type: 'upstream_error' } });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  process.stderr.write(`CodeMaster proxy on http://127.0.0.1:${port}/v1 · repo ${repo}\n`);
  return server;
}
