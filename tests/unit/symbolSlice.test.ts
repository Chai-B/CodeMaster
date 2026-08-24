// Symbol-slice compression (spec §5.2.5, §11.4) — keep only task-relevant symbol
// bodies, far cheaper than the whole file, richer than bare signatures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symbolSlice } from '../../src/context/fileSelector.js';

const SRC = `def serialize_sequence_value(field, value):
    return [field.serialize(v) for v in value]

def unrelated_helper(x):
    return x + 1

class Router:
    def add_route(self, path):
        self.routes.append(path)
`;

test('keeps the symbol matching a keyword, drops the rest', () => {
  const out = symbolSlice('fastapi/_compat.py', SRC, ['serialize'])!;
  assert.ok(out.includes('serialize_sequence_value'));
  assert.ok(!out.includes('unrelated_helper'));
  assert.ok(out.length < SRC.length + 60);
});

test('returns null when no symbol matches (caller falls back to signatures)', () => {
  assert.equal(symbolSlice('f.py', SRC, ['nonexistentterm']), null);
});

test('returns null when there are no keywords', () => {
  assert.equal(symbolSlice('f.py', SRC, []), null);
});

test('matches on the definition header, not only the body', () => {
  const out = symbolSlice('f.py', SRC, ['router'])!;
  assert.ok(out.includes('class Router'));
  assert.ok(!out.includes('serialize_sequence_value')); // unrelated symbol dropped
});
