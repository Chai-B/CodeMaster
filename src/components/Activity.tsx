import React, { useEffect, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { BLUE, BLUE_HI, BLUE_DIM, MUTED, GREEN, RED, AMBER, BRAILLE } from '../themes/blue.js';
import { fmtCost, fmtTokens } from '../util/tokens.js';
import type { LogEntry, Phase, SessionStatusView, UsageView } from '../util/parser.js';

/**
 * The live region: everything Ink still redraws once the settled transcript has
 * gone into the terminal's own scrollback.
 *
 * It is the whole answer to "what is happening right now" — which phase the run
 * is in and how long each took, the last few workers with their own elapsed
 * times, how far through the task list it is, and what it has cost so far. The
 * single rotating verb this replaced said only that something was happening.
 */

const PHASES: Phase[] = ['Planning', 'Solving', 'Verifying'];
const STEPS = 3;

function useCols(): number {
  const { stdout } = useStdout();
  return Math.max(28, stdout?.columns ?? 80);
}

/** Re-render on an interval so elapsed times count up between events. */
function useTick(ms: number, on: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setN((v) => v + 1), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return n;
}

function secs(since: number): number {
  return Math.max(0, Math.round((Date.now() - since) / 1000));
}

/** One row: `Planning ✓ 12s   Solving ⠹ 47s   Verifying ·`. The shape of the
 *  run, before you have read a word of its output. */
function Stepper({ phase, done, frame, cols }: {
  phase: Phase | null; done: Partial<Record<Phase, number>>; frame: number; cols: number;
}) {
  return (
    <Box width={cols}>
      <Text wrap="truncate-end">
        {'  '}
        {PHASES.map((p, i) => {
          const finished = done[p] !== undefined;
          const active = p === phase;
          const mark = finished ? '✓' : active ? BRAILLE[frame % BRAILLE.length]! : '·';
          const time = finished ? ` ${done[p]}s` : '';
          const color = finished ? GREEN : active ? BLUE_HI : BLUE_DIM;
          return (
            <Text key={p}>
              {i > 0 ? <Text color={BLUE_DIM}>{'    '}</Text> : ''}
              <Text color={active ? BLUE_HI : MUTED} bold={active}>{p}</Text>
              <Text color={color}>{` ${mark}${time}`}</Text>
            </Text>
          );
        })}
      </Text>
    </Box>
  );
}

/** `▰▰▱▱` — how much of the plan is behind you. A bare `2/4` is the same
 *  information, but you have to read it rather than see it. */
function TaskBar({ done, total }: { done: number; total: number }) {
  const cells = Math.min(12, Math.max(1, total));
  const on = Math.round((done / Math.max(1, total)) * cells);
  return (
    <Text>
      <Text color={GREEN}>{'▰'.repeat(on)}</Text>
      <Text color={BLUE_DIM}>{'▱'.repeat(cells - on)}</Text>
    </Text>
  );
}

export function Activity({ phase, phaseStart, phaseDone, steps, status, taskTitle }: {
  phase: Phase | null;
  phaseStart: number;
  phaseDone: Partial<Record<Phase, number>>;
  steps: LogEntry[];
  status: SessionStatusView | null;
  taskTitle: string;
}) {
  const cols = useCols();
  const frame = useTick(90, true);
  const shown = steps.slice(-STEPS);

  // The right-hand column is what the run is costing while you watch it.
  const cost = status && status.cost > 0 ? ` · ${fmtCost(status.cost)}` : '';
  const tok = status && status.tokens > 0 ? `${fmtTokens(status.tokens)} tok` : '';
  const meta = `${tok}${cost} · ${secs(phaseStart)}s`;

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* A deterministic command never enters a phase; three dim words above it
          would only say that nothing is happening. */}
      {phase && <Stepper phase={phase} done={phaseDone} frame={frame} cols={cols} />}

      <Box width={cols}>
        <Text color={BLUE_HI} bold>{'  '}{BRAILLE[frame % BRAILLE.length]}{'  '}</Text>
        <Box width={Math.max(4, cols - 6 - meta.length - 2)}>
          <Text color={BLUE_HI} wrap="truncate-end">{phase ?? 'Working'}</Text>
        </Box>
        <Text color={MUTED}>{`  ${meta}`}</Text>
      </Box>

      {shown.map((s, i) => {
        const age = s.at ? ` · ${secs(s.at)}s` : '';
        return (
          <Box key={s.id} width={cols}>
            <Text color={BLUE_DIM}>{'     '}{i === shown.length - 1 ? '⎿' : '│'}{' '}</Text>
            <Box width={Math.max(4, cols - 7 - age.length)}>
              <Text color={MUTED} wrap="truncate-end">{s.text}</Text>
            </Box>
            <Text color={BLUE_DIM}>{age}</Text>
          </Box>
        );
      })}

      {status && status.taskTotal > 0 && (
        <Box width={cols}>
          <Text color={MUTED}>{`  task ${status.taskN}/${status.taskTotal}  `}</Text>
          <TaskBar done={status.taskN} total={status.taskTotal} />
          <Box width={Math.max(4, cols - 12 - String(status.taskN).length - String(status.taskTotal).length - Math.min(12, Math.max(1, status.taskTotal)))}>
            <Text color={BLUE_DIM} wrap="truncate-end">{taskTitle ? `  ${taskTitle}` : ''}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

/** Eight cells of session budget, filled proportionally. */
function Budget({ used, total }: { used: number; total: number }) {
  const cells = 8;
  const frac = total > 0 ? Math.min(1, used / total) : 0;
  const on = Math.round(frac * cells);
  const color = frac > 0.9 ? RED : frac > 0.7 ? AMBER : GREEN;
  return (
    <Text>
      <Text color={color}>{'━'.repeat(on)}</Text>
      <Text color={BLUE_DIM}>{'━'.repeat(cells - on)}</Text>
      <Text color={MUTED}>{` ${fmtTokens(used)}`}</Text>
    </Text>
  );
}

/**
 * One line under the composer, and the only chrome that is always on screen.
 *
 * It carries what the pinned header used to: where you are, which model answers,
 * what the window has cost and whether you can run anything at all right now —
 * because the moment you need that is the moment before you start something
 * expensive.
 */
export function StatusBar({ shortCwd, usage, status, running, since }: {
  shortCwd: string; usage: UsageView; status: SessionStatusView | null; running: boolean; since: number;
}) {
  const cols = useCols();
  useTick(1000, running);

  // A deep path would otherwise take the whole line and push the model, the
  // budget and the rate-limit warning off the end of it — and the tail of a
  // path is the part that says where you are.
  const where = shortCwd.length > 30 ? '…' + shortCwd.slice(-29) : shortCwd;
  const parts: Array<[string, string, React.ReactNode?]> = [[where, MUTED], [usage.model, BLUE]];
  if (status) {
    parts.push(['', MUTED, <Budget key="b" used={status.tokens} total={status.tokenBudget} />]);
    if (status.cost > 0) parts.push([fmtCost(status.cost), MUTED]);
  } else if (usage.windowTokens > 0) {
    parts.push([`${fmtTokens(usage.windowTokens)} this window`, MUTED]);
  }
  if (usage.blockedMs > 0) parts.push([`rate limited ${mins(usage.blockedMs)}`, RED]);
  else if (!status && usage.spend > 0) parts.push([`${fmtCost(usage.spend)} total`, MUTED]);
  parts.push([
    running ? `running ${secs(since)}s · esc to interrupt` : '? for shortcuts',
    running ? AMBER : BLUE_DIM,
  ]);

  return (
    <Box paddingX={1} width={cols}>
      <Text wrap="truncate-end">
        {parts.map(([t, c, node], i) => (
          <Text key={t || 'budget'}>
            {i > 0 ? <Text color={BLUE_DIM}> · </Text> : ''}
            {node ?? <Text color={c}>{t}</Text>}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

function mins(ms: number): string {
  const m = Math.ceil(ms / 60_000);
  return m >= 60 ? `${Math.ceil(m / 60)}h` : `${m}m`;
}
