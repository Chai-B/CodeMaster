import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { BLUE, BLUE_HI, BLUE_DIM, MUTED, AMBER } from '../themes/blue.js';
import type { Choice, Field, PromptSpec, PromptResult } from '../ui/prompt.js';

/**
 * The answer to a question a command asked: a list to pick from, a pair of
 * buttons, or a short form filled one field at a time.
 *
 * It draws where the autocomplete draws and takes the keyboard while it is up,
 * so the composer is not focused and the transcript does not scroll under it.
 * Its height is a pure function of the spec (`promptRows`) because the frame is
 * pinned to the window — a panel whose height the layout cannot predict pushes
 * the composer off the bottom row.
 */

const MAX_ROWS = 9;

function fieldRows(f: Field): number {
  return f.choices ? Math.min(f.choices.length, MAX_ROWS) : 1;
}

/** Rows the panel occupies, including its top margin. */
export function promptRows(spec: PromptSpec): number {
  const chrome = 3; // top margin, title, key hints
  switch (spec.kind) {
    case 'select':
      return chrome + Math.min(spec.choices.length, MAX_ROWS);
    case 'confirm':
      return chrome + 1 + (spec.detail ? 1 : 0);
    case 'form':
      // One field at a time, at the height of the tallest — a body that
      // resized as you advanced would move everything above it.
      return chrome + 1 + Math.max(...spec.fields.map(fieldRows));
  }
}

function clip(s: string, w: number): string {
  if (w <= 0) return '';
  return s.length <= w ? s.padEnd(w) : `${s.slice(0, w - 1)}…`;
}

function ChoiceList({ choices, idx, cols }: { choices: Choice[]; idx: number; cols: number }) {
  // Keep the selection on screen when the list is longer than the window.
  const from =
    choices.length <= MAX_ROWS
      ? 0
      : Math.max(0, Math.min(idx - Math.floor(MAX_ROWS / 2), choices.length - MAX_ROWS));
  const shown = choices.slice(from, from + MAX_ROWS);
  const inner = cols - 4;
  const hintW = choices.some((c) => c.hint) ? Math.min(26, Math.floor(inner / 2)) : 0;
  const labelW = Math.max(4, inner - 5 - (hintW ? hintW + 2 : 0));
  return (
    <>
      {shown.map((c, i) => {
        const n = from + i;
        const on = n === idx;
        return (
          <Box key={c.value}>
            <Text color={on ? BLUE_HI : BLUE_DIM} bold={on}>{on ? ' ❯ ' : '   '}</Text>
            <Text color={MUTED}>{n < 9 ? `${n + 1} ` : '  '}</Text>
            <Text color={on ? BLUE_HI : BLUE} bold={on}>{clip(c.label, labelW)}</Text>
            {hintW > 0 && <Text color={MUTED}>{`  ${clip(c.hint ?? '', hintW)}`}</Text>}
          </Box>
        );
      })}
    </>
  );
}

function Button({ label, on, danger }: { label: string; on: boolean; danger?: boolean }) {
  const accent = danger ? AMBER : BLUE_HI;
  return (
    <Text color={on ? 'black' : accent} backgroundColor={on ? accent : undefined} bold={on}>
      {`  ${label}  `}
    </Text>
  );
}

export function Prompt({ spec, onDone }: { spec: PromptSpec; onDone: (r: PromptResult | null) => void }) {
  const { stdout } = useStdout();
  const cols = Math.max(28, stdout?.columns ?? 80);
  const [idx, setIdx] = useState(0);
  const [fieldIdx, setFieldIdx] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [text, setText] = useState('');

  const field = spec.kind === 'form' ? spec.fields[fieldIdx] : undefined;
  const choices = spec.kind === 'select' ? spec.choices : field?.choices;
  const typing = spec.kind === 'form' && !field?.choices;

  const commit = (name: string, value: string) => {
    const next = { ...values, [name]: value };
    if (spec.kind !== 'form') return;
    if (fieldIdx + 1 >= spec.fields.length) return onDone(next);
    setValues(next);
    setFieldIdx(fieldIdx + 1);
    setIdx(0);
    setText('');
  };

  useInput((c, key) => {
    if (key.escape || (key.ctrl && c === 'c')) return onDone(null);
    // A text field owns everything else: its own component handles the keys and
    // submitting it is what advances the form.
    if (typing) return;

    if (spec.kind === 'confirm') {
      if (key.leftArrow || key.rightArrow || key.tab) setIdx((v) => (v === 0 ? 1 : 0));
      if (c === 'y' || c === 'Y') return onDone(true);
      if (c === 'n' || c === 'N') return onDone(false);
      if (key.return) return onDone(idx === 0);
      return;
    }

    const list = choices ?? [];
    if (key.upArrow) setIdx((v) => (v <= 0 ? list.length - 1 : v - 1));
    if (key.downArrow) setIdx((v) => (v >= list.length - 1 ? 0 : v + 1));
    // Numbers pick directly, which is what a short list is for.
    if (/^[1-9]$/.test(c) && Number(c) <= list.length) {
      const pick = list[Number(c) - 1]!;
      return spec.kind === 'select' ? onDone(pick.value) : commit(field!.name, pick.value);
    }
    if (key.return) {
      const pick = list[idx];
      if (!pick) return;
      return spec.kind === 'select' ? onDone(pick.value) : commit(field!.name, pick.value);
    }
  });

  const keys =
    spec.kind === 'confirm'
      ? '←→ choose · y/n · enter confirm · esc cancel'
      : typing
        ? 'enter next · esc cancel'
        : '↑↓ move · 1-9 pick · enter choose · esc cancel';

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Box width={cols - 2}>
        <Text bold color={spec.kind === 'confirm' && spec.danger ? AMBER : BLUE_HI} wrap="truncate-end">
          {spec.title}
        </Text>
      </Box>

      {spec.kind === 'select' && <ChoiceList choices={spec.choices} idx={idx} cols={cols} />}

      {spec.kind === 'confirm' && (
        <>
          {spec.detail && (
            <Box width={cols - 2}>
              <Text color={MUTED} wrap="truncate-end">{`  ${spec.detail}`}</Text>
            </Box>
          )}
          <Box>
            <Text>{'   '}</Text>
            <Button label="Yes" on={idx === 0} danger={spec.danger} />
            <Text>{'  '}</Text>
            <Button label="No" on={idx === 1} danger={spec.danger} />
          </Box>
        </>
      )}

      {spec.kind === 'form' && field && (
        <Box flexDirection="column" height={1 + Math.max(...spec.fields.map(fieldRows))}>
          <Box width={cols - 2}>
            <Text color={MUTED}>{`  ${fieldIdx + 1}/${spec.fields.length}  `}</Text>
            <Text color={BLUE}>{field.label}</Text>
          </Box>
          {field.choices ? (
            <ChoiceList choices={field.choices} idx={idx} cols={cols} />
          ) : (
            <Box>
              <Text color={BLUE_DIM}>{'   ❯ '}</Text>
              <TextInput
                value={text}
                onChange={setText}
                onSubmit={(v) => v.trim() && commit(field.name, v.trim())}
                focus
                showCursor
                mask={field.secret ? '•' : undefined}
                placeholder={field.placeholder}
              />
            </Box>
          )}
        </Box>
      )}

      <Box width={cols - 2}>
        <Text color={BLUE_DIM} wrap="truncate-end">{`  ${keys}`}</Text>
      </Box>
    </Box>
  );
}
