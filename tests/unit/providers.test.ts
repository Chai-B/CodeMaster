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
