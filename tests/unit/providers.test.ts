// Contract tests (spec §24.1) — every ProviderAdapter normalizes its native
// output format (XML / JSON / diff) to the same IR. invoke() is not called.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { CodexAdapter } from '../../src/providers/codex.js';
import type { ProviderResponse } from '../../src/types/index.js';

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
