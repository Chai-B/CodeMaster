// The verdict used to default to `pass` when it could not be read, so a
// reviewer that returned prose, or nothing, was recorded as approval.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerification } from '../../src/workers/verifier.js';

test('a well-formed review is read as it stands', () => {
  const r = parseVerification(
    '<verification><verdict>pass</verdict><summary>looks right</summary></verification>',
  );
  assert.equal(r.verdict, 'pass');
  assert.equal(r.summary, 'looks right');
  assert.deepEqual(r.issues, []);
});

test('issues come through with the verdict', () => {
  const r = parseVerification(
    '<verdict>fail</verdict><summary>no</summary><issue>off by one</issue><issue>no test</issue>',
  );
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.issues, ['off by one', 'no test']);
});

test('a reply with no verdict is unverified, not approved', () => {
  const r = parseVerification('The diff looks broadly reasonable to me.');
  assert.equal(r.verdict, 'partial');
  assert.match(r.issues.join('\n'), /could not be parsed/);
  assert.notEqual(r.summary, '');
});

test('a verdict that is not one of the three is unverified, not approved', () => {
  const r = parseVerification('<verdict>looks good!</verdict><summary>fine</summary>');
  assert.equal(r.verdict, 'partial');
  assert.match(r.issues.join('\n'), /looks good!/);
});

test('case and whitespace around a real verdict do not break it', () => {
  assert.equal(parseVerification('<verdict>\n  PASS \n</verdict>').verdict, 'pass');
});
