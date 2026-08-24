// The MCP surface is what other agents see. Its tool contracts must stay
// well-formed, and the read-only tools must not create state in a project.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.CODEMASTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-mcp-'));

const { MCP_TOOLS } = await import('../../src/mcp.js');

test('every tool declares a usable JSON schema', () => {
  assert.ok(MCP_TOOLS.length > 0);
  for (const t of MCP_TOOLS) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.ok(t.description.length > 40, `${t.name} needs a real description`);
    assert.equal((t.inputSchema as { type: string }).type, 'object');
    assert.ok((t.inputSchema as { properties: object }).properties);
  }
});

test('the context tools are exposed under stable names', () => {
  const names = MCP_TOOLS.map((t) => t.name);
  for (const n of ['compile_context', 'relevant_files', 'prior_reasoning', 'record_reasoning', 'repository_map']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});

test('an unindexed repository reports that rather than throwing', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-mcp-repo-'));
  const map = MCP_TOOLS.find((t) => t.name === 'repository_map')!;
  const out = await map.run({}, empty);
  assert.match(out, /not indexed/i);
});
