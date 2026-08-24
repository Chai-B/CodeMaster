// Golden test (spec §24.2) — calls a real provider API and checks the output
// STRUCTURE (not content). Skipped unless a key is present, so it never runs in
// the default CI lane (cost/latency); run on a separate schedule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { SYSTEM_PROMPT, OUTPUT_FORMAT } from '../../src/context/outputFormat.js';
import type { Account } from '../../src/types/index.js';

const hasKey = !!process.env.ANTHROPIC_API_KEY;

test('golden: Claude returns a parseable <task_result>', { skip: !hasKey }, async () => {
  const adapter = new AnthropicAdapter([
    { id: 'claude-sonnet-4-6', context_size: 200000, cost_per_1m_input: 3, cost_per_1m_output: 15 },
  ]);
  const account = { id: 'a', provider_id: 'anthropic', credential_ref: 'env:ANTHROPIC_API_KEY' } as Account;
  const req = adapter.format_prompt(
    {
      session_id: 's', task_id: 't', task_type: 'implement', compiled_at: '',
      system: SYSTEM_PROMPT,
      body: `# Task\nAdd a function \`sum(a,b)\` to math.ts.\n\n${OUTPUT_FORMAT}`,
      components: [], total_tokens: 0, max_tokens: 200000, included: [], omitted: [],
    },
    'claude-sonnet-4-6',
  );
  const resp = await adapter.invoke(req, account);
  const ir = adapter.parse_response(resp, 's', 't');
  // Structure assertions only — not exact content.
  assert.ok(['completed', 'partial', 'needs_clarification'].includes(ir.status));
  assert.equal(ir.ir_version, '1.0');
  assert.ok(Array.isArray(ir.patches));
});
