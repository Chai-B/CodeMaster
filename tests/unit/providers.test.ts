// Contract tests (spec §24.1) — every ProviderAdapter normalizes its native
// output format (XML / JSON / diff) to the same IR. invoke() is not called.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldOpencodeEvents } from '../../src/providers/opencode.js';
import { parseGeminiJson, usageFromGeminiStats } from '../../src/providers/gemini.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { CodexAdapter } from '../../src/providers/codex.js';
import type { ProviderResponse } from '../../src/types/index.js';
import fs from 'fs';
import path from 'path';

function resp(text: string, model: string): ProviderResponse {
  return { text, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, model, latency_ms: 1 };
}

const XML = `<task_result><status>completed</status><summary>add foo</summary>
<patches><patch file="a.ts">--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new</patch></patches>
<reasoning><decision question="q" answer="X" confidence="0.9"></decision></reasoning></task_result>`;

const JSON_OUT = JSON.stringify({
  status: 'completed',
  summary: 'add foo',
  patches: [{ file: 'a.ts', diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new' }],
  decisions: [{ question: 'q', answer: 'X', confidence: 0.9 }],
});

const DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new`;

test('Anthropic adapter parses native XML to IR', () => {
  const ir = new AnthropicAdapter([{ id: 'm', context_size: 1000, cost_per_1m_input: 1, cost_per_1m_output: 1 }])
    .parse_response(resp(XML, 'm'), 's', 't');
  assert.equal(ir.status, 'completed');
  assert.equal(ir.patches.length, 1);
  assert.equal(ir.patches[0]!.file, 'a.ts');
  assert.equal(ir.decisions.length, 1);
});

test('OpenAI adapter parses native JSON to IR', () => {
  const ir = new OpenAIAdapter([]).parse_response(resp(JSON_OUT, 'gpt-4.1'), 's', 't');
  assert.equal(ir.status, 'completed');
  assert.equal(ir.patches[0]!.file, 'a.ts');
  assert.equal(ir.decisions[0]!.answer, 'X');
});

test('Gemini adapter parses native JSON to IR', () => {
  const ir = new GeminiAdapter([]).parse_response(resp(JSON_OUT, 'gemini-2.5-pro'), 's', 't');
  assert.equal(ir.patches.length, 1);
  assert.equal(ir.decisions.length, 1);
});

test('Codex adapter parses native unified diff to IR', () => {
  const ir = new CodexAdapter([]).parse_response(resp(DIFF, 'codex-2'), 's', 't');
  assert.equal(ir.status, 'completed');
  assert.equal(ir.patches.length, 1);
  assert.equal(ir.patches[0]!.file, 'a.ts');
});

test('all adapters agree on patch target for equivalent output', () => {
  const a = new AnthropicAdapter([{ id: 'm', context_size: 1, cost_per_1m_input: 1, cost_per_1m_output: 1 }]).parse_response(resp(XML, 'm'), 's', 't');
  const o = new OpenAIAdapter([]).parse_response(resp(JSON_OUT, 'm'), 's', 't');
  const c = new CodexAdapter([]).parse_response(resp(DIFF, 'm'), 's', 't');
  assert.equal(a.patches[0]!.file, o.patches[0]!.file);
  assert.equal(o.patches[0]!.file, c.patches[0]!.file);
});

test('a pinned model never fails over to another model', async () => {
  const { ProviderManager } = await import('../../src/providers/manager.js');
  const models = (id: string): { id: string; context_size: number; cost_per_1m_input: number; cost_per_1m_output: number }[] => [
    { id, context_size: 200_000, cost_per_1m_input: 1, cost_per_1m_output: 5 },
  ];
  const cfg = {
    providers: {
      default: 'claude-haiku-4-5-20251001',
      pinned: true,
      anthropic: { models: models('claude-haiku-4-5-20251001') },
      openai: { models: models('gpt-5-codex') },
      google: { models: models('gemini-3-pro') },
      openai_codex: { models: models('gpt-5-codex-cli') },
    },
  } as unknown as ConstructorParameters<typeof ProviderManager>[0];

  const m = new ProviderManager(cfg);
  // Private, but this ordering IS the guarantee: a benchmark pinned to haiku
  // failed over to gpt-5-codex mid-run and reported numbers for neither.
  const order = (m as unknown as { failoverModelOrder(): string[] }).failoverModelOrder();
  assert.deepEqual(order, ['claude-haiku-4-5-20251001']);

  cfg.providers.pinned = false;
  const open = new ProviderManager(cfg);
  const wide = (open as unknown as { failoverModelOrder(): string[] }).failoverModelOrder();
  assert.ok(wide.length >= order.length);
});

test('a pin collapses every role to one model; unpinned, mechanical roles go cheaper', async () => {
  const { ProviderManager } = await import('../../src/providers/manager.js');
  const { LLM_ROLES } = await import('../../src/types/index.js');
  const cfg = {
    providers: {
      default: 'claude-sonnet-4-6',
      pinned: true,
      anthropic: {
        models: [
          { id: 'claude-sonnet-4-6', context_size: 200_000, cost_per_1m_input: 3, cost_per_1m_output: 15 },
          { id: 'claude-haiku-4-5-20251001', context_size: 200_000, cost_per_1m_input: 1, cost_per_1m_output: 5 },
        ],
      },
      openai: { models: [] },
      google: { models: [] },
      openai_codex: { models: [] },
    },
  } as unknown as ConstructorParameters<typeof ProviderManager>[0];

  // `--model` is a promise that every call in the run used that exact model. A
  // role table that routed underneath it would silently break the promise and
  // make any A/B measured against the run meaningless.
  const pinned = new ProviderManager(cfg);
  for (const role of LLM_ROLES) assert.equal(pinned.modelFor(role), 'claude-sonnet-4-6');
  assert.equal(pinned.modelFor('summarize', 'claude-haiku-4-5-20251001'), 'claude-sonnet-4-6');

  // Unpinned and with no `roles` table written anywhere, the mechanical roles
  // still land on the cheaper model — the defaults are derived, not configured.
  cfg.providers.pinned = false;
  const open = new ProviderManager(cfg);
  assert.equal(open.modelFor('solve'), 'claude-sonnet-4-6');
  assert.equal(open.modelFor('plan'), 'claude-sonnet-4-6');
  assert.equal(open.modelFor('oracle'), 'claude-sonnet-4-6');
  for (const role of ['review', 'summarize', 'merge'] as const) {
    assert.equal(open.modelFor(role), 'claude-haiku-4-5-20251001');
  }

  // A requested model that does not exist is not a choice; falling back beats
  // failing, since the caller may be a proxy client naming a foreign model.
  assert.equal(open.modelFor('solve', 'gpt-4-imaginary'), 'claude-sonnet-4-6');
});

// One model for a whole run means paying the hardest job's price on every job.
// The tier is the automatic half of routing: a pure function of what the caller
// already knows about the job, resolved against whatever the vendor lists.
test('a job is sized by what it carries, and the tier picks the model', async () => {
  const { ProviderManager, tierFor } = await import('../../src/providers/manager.js');

  // A mechanical transform is settled by its role alone — the answer is already
  // in the prompt, and no amount of model produces a better summary of it.
  for (const role of ['review', 'summarize', 'merge'] as const) {
    assert.equal(tierFor({ role, taskType: 'debug', files: 20 }), 'light');
  }

  assert.equal(tierFor({ role: 'solve', taskType: 'test', files: 1 }), 'light');
  assert.equal(tierFor({ role: 'solve', taskType: 'implement', files: 1 }), 'standard');
  assert.equal(tierFor({ role: 'solve', taskType: 'debug', files: 1 }), 'standard');
  assert.equal(tierFor({ role: 'solve', taskType: 'debug', files: 4 }), 'heavy');
  assert.equal(tierFor({ role: 'solve', taskType: 'implement', files: 12 }), 'heavy');
  assert.equal(tierFor({ role: 'solve', taskType: 'implement', contextTokens: 60_000 }), 'heavy');
  // A pass already failed at the smaller context budget, or this repository has
  // needed the bigger one before. Either way it is not an ordinary job.
  assert.equal(tierFor({ role: 'solve', taskType: 'implement', files: 1, contextTier: 1 }), 'heavy');
  // An answer a person reads is never checked by a gate, so it holds the floor.
  assert.equal(tierFor({ role: 'solve', taskType: 'review', files: 1 }), 'light');
  assert.equal(tierFor({ role: 'solve', taskType: 'review', files: 1, prose: true }), 'standard');

  const cfg = {
    providers: {
      default: 'claude-sonnet-4-6',
      anthropic: {
        models: [
          { id: 'claude-opus-4-8', context_size: 200_000, cost_per_1m_input: 15, cost_per_1m_output: 75 },
          { id: 'claude-sonnet-4-6', context_size: 200_000, cost_per_1m_input: 3, cost_per_1m_output: 15 },
          { id: 'claude-haiku-4-5-20251001', context_size: 200_000, cost_per_1m_input: 1, cost_per_1m_output: 5 },
        ],
      },
      openai: { models: [] },
      google: { models: [] },
      openai_codex: { models: [] },
    },
  } as unknown as ConstructorParameters<typeof ProviderManager>[0];

  const m = new ProviderManager(cfg);
  // 'standard' is the configured default, so setting `providers.default` still
  // decides what ordinary work runs on; the tier only moves off it either way.
  assert.equal(m.modelFor('solve', undefined, 'light'), 'claude-haiku-4-5-20251001');
  assert.equal(m.modelFor('solve', undefined, 'standard'), 'claude-sonnet-4-6');
  assert.equal(m.modelFor('solve', undefined, 'heavy'), 'claude-opus-4-8');

  // Precedence is unchanged: an explicitly configured role, an explicitly
  // requested model and a pin each beat the automatic choice, in that order.
  cfg.providers.roles = { solve: 'claude-haiku-4-5-20251001' };
  assert.equal(new ProviderManager(cfg).modelFor('solve', undefined, 'heavy'), 'claude-haiku-4-5-20251001');
  delete cfg.providers.roles;
  assert.equal(m.modelFor('solve', 'claude-haiku-4-5-20251001', 'heavy'), 'claude-haiku-4-5-20251001');
  cfg.providers.pinned = true;
  const pinned = new ProviderManager(cfg);
  for (const t of ['light', 'standard', 'heavy'] as const) {
    assert.equal(pinned.modelFor('solve', undefined, t), 'claude-sonnet-4-6');
  }
  cfg.providers.pinned = false;

  // A default the user set above everything the vendor lists is still what
  // 'heavy' means — a step up may never resolve to something weaker.
  cfg.providers.default = 'claude-opus-4-8';
  const top = new ProviderManager(cfg);
  assert.equal(top.modelFor('solve', undefined, 'heavy'), 'claude-opus-4-8');
  assert.equal(top.modelFor('solve', undefined, 'light'), 'claude-haiku-4-5-20251001');
});

// Holding keys for several vendors at once is the point of /account; choosing
// one has to actually move the calls. It did not: routing resolved the model
// first, and the preference only picked between accounts already on that
// model's vendor, so selecting an OpenAI account left every call on Anthropic.
test('choosing an account on another vendor moves the calls to that vendor', async () => {
  const { ProviderManager } = await import('../../src/providers/manager.js');
  const cfg = {
    providers: {
      default: 'claude-sonnet-4-6',
      anthropic: {
        models: [
          { id: 'claude-sonnet-4-6', context_size: 200_000, cost_per_1m_input: 3, cost_per_1m_output: 15 },
          { id: 'claude-haiku-4-5-20251001', context_size: 200_000, cost_per_1m_input: 1, cost_per_1m_output: 5 },
        ],
      },
      openai: {
        models: [
          { id: 'gpt-5', context_size: 400_000, cost_per_1m_input: 2, cost_per_1m_output: 14 },
          { id: 'gpt-5-mini', context_size: 400_000, cost_per_1m_input: 1, cost_per_1m_output: 3 },
        ],
      },
      google: { models: [] },
      openai_codex: { models: [] },
    },
  } as unknown as ConstructorParameters<typeof ProviderManager>[0];

  const prevOpenai = process.env.OPENAI_API_KEY;
  const prevAnthropic = process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  try {
    const m = new ProviderManager(cfg);
    // Every vendor's env-backed account is named for its vendor, so the four of
    // them are distinguishable — they were all called 'default'.
    const aliases = m.listAccounts().map((a) => a.alias);
    assert.equal(new Set(aliases).size, aliases.length, `duplicate aliases: ${aliases}`);

    assert.equal(m.modelFor('solve'), 'claude-sonnet-4-6');
    assert.ok(m.useAccount('openai'));
    // Nearest in price to the configured default, not the vendor's first listing.
    assert.equal(m.modelFor('solve'), 'gpt-5');
    // The whole table follows, tiers included.
    assert.equal(m.modelFor('solve', undefined, 'light'), 'gpt-5-mini');
    assert.equal(m.modelFor('summarize'), 'gpt-5-mini');

    // A pin is still a promise about one model, and it outranks the choice.
    cfg.providers.pinned = true;
    const pinned = new ProviderManager(cfg);
    assert.ok(pinned.useAccount('openai'));
    assert.equal(pinned.modelFor('solve'), 'claude-sonnet-4-6');
    cfg.providers.pinned = false;

    // A preference for a vendor with no key must not strand a working run.
    delete process.env.OPENAI_API_KEY;
    const keyless = new ProviderManager(cfg);
    assert.ok(keyless.useAccount('openai'));
    assert.equal(keyless.modelFor('solve'), 'claude-sonnet-4-6');
  } finally {
    if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenai;
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropic;
  }
});

test('a free-form prompt is not overridden by a provider-native output format', () => {
  const spec = [{ id: 'm', context_size: 100_000, cost_per_1m_input: 1, cost_per_1m_output: 1 }];
  const adapters = [new OpenAIAdapter(spec), new GeminiAdapter(spec), new CodexAdapter(spec)];
  const compiled = {
    session_id: 's', task_id: 't', task_type: 'review' as const, compiled_at: '',
    system: 'answer in prose', body: '# Question\nWhat does foo do?',
    components: [], total_tokens: 0, max_tokens: 100_000, included: [], omitted: [],
  };

  for (const a of adapters) {
    // These three adapters each append their own contract — JSON for OpenAI and
    // Gemini, a unified diff for Codex. `/ask` wants an answer a person reads,
    // so the body it compiled has to survive the adapter untouched.
    const free = a.format_prompt({ ...compiled, free_form: true }, 'm');
    assert.equal(free.user, compiled.body, `${a.constructor.name} overrode a free-form prompt`);

    // The default path is unchanged: a work-product prompt still gets the
    // machine-readable contract, or nothing downstream can parse the result.
    const normal = a.format_prompt(compiled, 'm');
    assert.ok(normal.user.length > compiled.body.length, `${a.constructor.name} dropped its output format`);
  }
});

test('opencode: an event stream folds into an answer, its thinking and its real token count', () => {
  // Shape taken from `opencode run --format json`: every line is
  // {type, timestamp, sessionID, ...event}.
  const lines = [
    '{"type":"step_start","timestamp":1,"sessionID":"s"}',
    '{"type":"reasoning","timestamp":2,"sessionID":"s","part":{"text":"the join is unbounded"}}',
    '{"type":"tool_use","timestamp":3,"sessionID":"s","part":{"tool":"read","state":{"status":"completed"}}}',
    '{"type":"step_finish","timestamp":4,"sessionID":"s","part":{"cost":0,"tokens":{"input":100,"output":20,"reasoning":30,"cache":{"read":10,"write":0}}}}',
    '{"type":"text","timestamp":5,"sessionID":"s","part":{"text":"--- a/x\\n+++ b/x"}}',
    '{"type":"step_finish","timestamp":6,"sessionID":"s","part":{"cost":0,"tokens":{"input":5,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}}',
    'not json at all',
  ];
  const out = foldOpencodeEvents(lines);
  assert.equal(out.text, '--- a/x\n+++ b/x');
  assert.equal(out.reasoning, 'the join is unbounded');
  assert.equal(out.usage.input_tokens, 105);
  // Reasoning is billed as output and reported apart from it, so it is added in.
  assert.equal(out.usage.output_tokens, 51);
  assert.equal(out.usage.cache_read_tokens, 10);
  assert.equal(out.usage.total_tokens, 156);
  assert.equal(out.error, undefined);
});

test('opencode: an upstream failure is named, not swallowed', () => {
  const out = foldOpencodeEvents([
    '{"type":"error","timestamp":1,"sessionID":"s","error":{"name":"APIError","data":{"message":"Model is unavailable."}}}',
  ]);
  assert.equal(out.text, '');
  assert.equal(out.error, 'Model is unavailable.');
  assert.equal(out.usage.total_tokens, 0);
});

test('gemini: the CLI reports real token counts, thinking included', () => {
  // `gemini -o json` prints {response, stats}; stats.models[<id>].tokens is the
  // only place the counts appear. This path used to record zeros.
  const body = parseGeminiJson(
    'Loaded cached credentials.\n' +
      JSON.stringify({
        response: 'ok',
        stats: {
          models: {
            'gemini-3-pro': { tokens: { prompt: 900, candidates: 40, thoughts: 60, cached: 300, total: 1000 } },
            'gemini-3-flash': { tokens: { prompt: 100, candidates: 10, thoughts: 0, cached: 0, total: 110 } },
          },
        },
      }),
  );
  assert.equal(body?.response, 'ok');
  const u = usageFromGeminiStats(body?.stats);
  assert.equal(u.input_tokens, 1000);
  assert.equal(u.output_tokens, 110);
  assert.equal(u.cache_read_tokens, 300);
  assert.equal(u.total_tokens, 1110);

  assert.equal(parseGeminiJson('no json here'), null);
  assert.equal(usageFromGeminiStats(undefined).total_tokens, 0);
});

// An `/ask` answer is prose. Each provider appends its own output contract to
// the compiled body, and every one of them has to stand down when the prompt is
// free-form — otherwise the answer arrives as a diff or a JSON envelope and the
// question mode's own instructions are contradicted by whichever contract was
// appended last. Four independent guards, so this is what holds them together.
test('no provider appends an output contract to a free-form prompt', () => {
  const dir = path.join(process.cwd(), 'src/providers');
  const offenders: string[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of src.split('\n')) {
      // The import of the constant is not the append; the interpolation is.
      if (!/\$\{[A-Z_]*OUTPUT_FORMAT\}/.test(line)) continue;
      if (!line.includes('free_form')) offenders.push(`${f}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('question mode and patch mode do not share an output contract', async () => {
  const { PROSE_OUTPUT_FORMAT, OUTPUT_FORMAT, PROSE_SYSTEM_PROMPT } = await import('../../src/context/outputFormat.js');
  assert.notEqual(PROSE_OUTPUT_FORMAT, OUTPUT_FORMAT);
  // Prose must not ask for the tags the patch contract is built out of, or the
  // answer comes back wrapped in a format nothing renders.
  for (const tag of ['<patch', '<file', '<diff']) {
    assert.ok(!PROSE_OUTPUT_FORMAT.includes(tag), `prose contract still asks for ${tag}`);
    assert.ok(!PROSE_SYSTEM_PROMPT.includes(tag), `prose system prompt still asks for ${tag}`);
  }
});

// `prose: true` is the only thing that sets `free_form`, so the guards above
// are load-bearing only while this line survives.
test('prose is what makes a compiled prompt free-form', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/context/compiler.ts'), 'utf8');
  assert.match(src, /free_form:\s*opts\.prose/);
  assert.match(src, /opts\.prose \? PROSE_OUTPUT_FORMAT : OUTPUT_FORMAT/);
});
