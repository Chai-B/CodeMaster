// Drag-to-select exists because claiming the mouse for the wheel took the
// terminal's own selection away. `extract` is where all the off-by-ones live.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract } from '../../src/ui/selection.js';

// A frame is space-padded to the full width, which is why trimming matters.
const FRAME = [
  'first line here     ',
  'second line         ',
  'third line          ',
];

test('a drag inside one row takes exactly the cells it covered', () => {
  assert.equal(extract(FRAME, { row: 1, col: 7 }, { row: 1, col: 10 }), 'line');
});

test('the cell under the pointer is included at both ends', () => {
  assert.equal(extract(FRAME, { row: 2, col: 1 }, { row: 2, col: 1 }), 's');
});

test('spanning rows runs to end of line and back from column one', () => {
  assert.equal(
    extract(FRAME, { row: 1, col: 7 }, { row: 3, col: 5 }),
    'line here\nsecond line\nthird',
  );
});

test('dragging backwards is the same selection as dragging forwards', () => {
  const fwd = extract(FRAME, { row: 1, col: 7 }, { row: 3, col: 5 });
  assert.equal(extract(FRAME, { row: 3, col: 5 }, { row: 1, col: 7 }), fwd);
  const within = extract(FRAME, { row: 2, col: 8 }, { row: 2, col: 11 });
  assert.equal(extract(FRAME, { row: 2, col: 11 }, { row: 2, col: 8 }), within);
});

test('the padding the frame adds is not copied', () => {
  assert.equal(extract(FRAME, { row: 2, col: 1 }, { row: 2, col: 20 }), 'second line');
});

test('a drag past the last row stops at the last row', () => {
  assert.equal(extract(FRAME, { row: 3, col: 1 }, { row: 99, col: 40 }), 'third line');
});

test('an empty frame yields nothing rather than throwing', () => {
  assert.equal(extract([], { row: 1, col: 1 }, { row: 4, col: 9 }), '');
});
