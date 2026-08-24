import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIR, ParseError } from '../../src/workers/outputParser.js';

const ref = { provider_id: 'anthropic', model_id: 'claude-sonnet-4-6' };

test('parses a full task_result block', () => {
  const raw = `prefix
<task_result>
<status>completed</status>
<summary>did the thing</summary>
<new_files><file path="x.ts">export const x = 1;</file></new_files>
<reasoning>
<decision question="q?" answer="a" confidence="0.9" reversibility="easy"><evidence>e</evidence><alternative option="o" rejected_because="r"/></decision>
<risk likelihood="high" impact="critical"><description>boom</description><mitigation>m</mitigation></risk>
</reasoning>
<wiki_updates><update key="modules/x">content</update></wiki_updates>
<next_tasks><task priority="high" type="test">write tests</task></next_tasks>
</task_result>`;
  const ir = parseIR(raw, 's', 't', ref);
  assert.equal(ir.status, 'completed');
  assert.equal(ir.summary, 'did the thing');
  assert.equal(ir.files_created.length, 1);
  assert.equal(ir.files_created[0]!.path, 'x.ts');
  assert.equal(ir.decisions.length, 1);
  assert.equal(ir.decisions[0]!.answer, 'a');
  assert.equal(ir.decisions[0]!.alternatives_rejected.length, 1);
  assert.equal(ir.risks.length, 1);
  assert.equal(ir.risks[0]!.impact, 'critical');
  assert.equal(ir.wiki_updates[0]!.key, 'modules/x');
  assert.equal(ir.next_tasks[0]!.type, 'test');
});

test('throws ParseError when no task_result present', () => {
  assert.throws(() => parseIR('just some prose', 's', 't', ref), ParseError);
});

test('defaults unknown status to completed', () => {
  const ir = parseIR('<task_result><status>weird</status><summary>s</summary></task_result>', 's', 't', ref);
  assert.equal(ir.status, 'completed');
});
