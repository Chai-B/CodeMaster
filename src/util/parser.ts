// Event → log-entry mapping for the TUI (replaces the old subprocess stdout parser).

import type { CodeMasterEvent } from '../events/types.js';

export type LogType =
  | 'plain'
  | 'tool'
  | 'success'
  | 'error'
  | 'warn'
  | 'dim'
  | 'result'
  | 'md'
  | 'heading'
  | 'sep'
  | 'user'
  | 'reasoning';

/** Which stage of a run a line belongs to. Settled stages collapse to a single
 *  result line so a finished run reads as four lines, not four hundred. */
export type Phase = 'Planning' | 'Solving' | 'Verifying';

export interface LogEntry {
  id: number;
  type: LogType;
  text: string;
  phase?: Phase;
  /** When the line was created, so the live region can count a step's age up.
   *  Only set by the reducer — a literal entry in a test does not need one. */
  at?: number;
  /** Long-form body kept out of the way until the reader asks for it. */
  detail?: string;
}

/** The phase a line belongs to, from the text the router and workers already
 *  emit. Deliberately a lookup on existing output rather than a new field
 *  threaded through every emitter. */
export function phaseOf(entry: Omit<LogEntry, 'id'>, current: Phase | null): Phase | null {
  const t = entry.text;
  if (entry.type === 'heading') {
    if (/^Planning/.test(t)) return 'Planning';
    if (/^Done/.test(t)) return null;
    return current;
  }
  // A task boundary is emitted as a separator: everything after it is the solve.
  if (entry.type === 'sep') return 'Solving';
  if (/^Solver iteration/.test(t)) return 'Solving';
  if (/^(Verification|Applied, but unverified|Verifier)/.test(t)) return 'Verifying';
  return current;
}

/** What is true of the tool regardless of whether a session is running: which
 *  model answers, what the vendor has counted against the current window, and
 *  what this repository has cost so far. Shown at all times, because the moment
 *  you need it is the moment before you start something expensive. */
export interface UsageView {
  model: string;
  /** Tokens the vendor has counted in the account's current rate-limit window. */
  windowTokens: number;
  /** Milliseconds until a rate-limited account is usable again; 0 when it is. */
  blockedMs: number;
  /** Spend recorded against this repository, all sessions. */
  spend: number;
}

export interface SessionStatusView {
  id: string;
  status: string;
  taskN: number;
  taskTotal: number;
  tokens: number;
  tokenBudget: number;
  cost: number;
  provider: string;
  lastCheckpoint?: string;
}

// Map a bus event to a renderable log line (or null to ignore).
export function eventToLog(ev: CodeMasterEvent): Omit<LogEntry, 'id'> | null {
  switch (ev.type) {
    case 'log': {
      const map: Record<string, LogType> = {
        info: 'plain', warn: 'warn', error: 'error', success: 'success',
        debug: 'dim', dim: 'dim', heading: 'heading', sep: 'sep', md: 'md',
      };
      return { type: map[ev.level] ?? 'plain', text: ev.message };
    }
    // The glyph in the gutter already points; a second arrow in the text was
    // one arrow too many.
    case 'worker.started':
      return { type: 'tool', text: `${ev.worker}${ev.detail ? ` — ${ev.detail}` : ''}` };
    case 'worker.finished':
      return { type: 'result', text: ev.detail ?? ev.worker };
    case 'task.started':
      return { type: 'sep', text: ev.title };
    case 'task.completed':
      return { type: 'success', text: `Task completed (${(ev.ms / 1000).toFixed(1)}s, ${ev.tokens.toLocaleString()} tokens)` };
    case 'task.failed':
      return { type: 'error', text: `Task failed: ${ev.reason}` };
    // The summary is the line; the detail hangs behind ctrl+r. This used to
    // read "decision recorded" and discard the decision.
    case 'reasoning.new':
      return { type: 'reasoning', text: `${ev.reasoning_type}  ${ev.summary}`, detail: ev.detail };
    // Both of these restated what the worker line beside them already said,
    // and the header's budget bar now counts tokens live.
    case 'provider.invoked':
    case 'provider.response':
      return null;
    case 'provider.switched':
      return { type: 'warn', text: `Provider switched: ${ev.from} → ${ev.to}` };
    case 'provider.error':
      return { type: 'error', text: `Provider ${ev.provider_id} failed: ${ev.error}` };
    case 'provider.rate_limited':
      return { type: 'warn', text: `Rate limited (${ev.account_id}) — retry in ${Math.round(ev.retry_after_ms / 1000)}s` };
    case 'quota.exhausted':
      return { type: 'error', text: `Quota exhausted for account ${ev.account_id}` };
    case 'wiki.created':
      return { type: 'dim', text: `Wiki created: ${ev.key}` };
    case 'wiki.updated':
      return { type: 'dim', text: `Wiki updated: ${ev.key}` };
    case 'wiki.conflict':
      return { type: 'warn', text: `Wiki conflict queued: ${ev.key}` };
    case 'checkpoint.created':
      return { type: 'dim', text: `Checkpoint created (${ev.trigger})` };
    case 'checkpoint.restored':
      return { type: 'success', text: `Checkpoint restored: ${ev.id}` };
    case 'session.created':
    case 'session.started':
    case 'session.paused':
    case 'session.resumed':
    case 'session.completed':
      return null; // reflected in the status bar, not the log
    default:
      return null;
  }
}

// ── Log state ───────────────────────────────────────────────────────────────
// Two regions, not one list. `settled` is the transcript proper and goes into
// the terminal's own scrollback through Ink's `<Static>`, one line at a time,
// never to be repainted. `live` is the phase currently running and is the only
// thing Ink redraws. When a phase ends it collapses to a single result line and
// moves across, so a finished run reads as a few lines rather than every line
// the workers emitted.
export interface LogState {
  settled: LogEntry[];
  live: LogEntry[];
  phase: Phase | null;
  phaseStart: number;
  /** Seconds each finished phase took, for the stepper. */
  phaseDone: Partial<Record<Phase, number>>;
  clearGen: number;
  verbose: boolean;
}

export const EMPTY_LOGS: LogState = { settled: [], live: [], phase: null, phaseStart: 0, phaseDone: {}, clearGen: 0, verbose: false };

let _id = 0;

/** Lines that are the run's output rather than a note about its progress.
 *  These never enter the live region, so a phase ending can never take them
 *  with it — the answer, the reasoning and the verdict stay on screen while
 *  "FileSelector — 7 files" does not. */
const KEEP = new Set<LogType>(['md', 'reasoning', 'heading', 'success', 'error', 'warn', 'sep', 'user']);

/** What a finished phase leaves behind: how long it took and how many steps it
 *  took to get there. Only progress lines are ever in `live`, so this discards
 *  nothing a reader would want back. */
function collapse(state: LogState): LogEntry[] {
  const n = state.live.length;
  if (!state.phase || n === 0) return [];
  const secs = Math.max(0, Math.round((Date.now() - state.phaseStart) / 1000));
  return [{ id: ++_id, type: 'dim', text: `${state.phase} · ${n} step${n === 1 ? '' : 's'} · ${secs}s` }];
}

export function logReducer(
  state: LogState,
  action:
    | { type: 'add'; entry: Omit<LogEntry, 'id'> }
    | { type: 'clear' }
    | { type: 'verbose'; on: boolean },
): LogState {
  if (action.type === 'clear') return { ...EMPTY_LOGS, clearGen: state.clearGen + 1, verbose: state.verbose };
  if (action.type === 'verbose') return { ...state, verbose: action.on };

  const phase = phaseOf(action.entry, state.phase);
  const entry: LogEntry = { ...action.entry, phase: phase ?? undefined, at: Date.now(), id: ++_id };

  // A phase boundary settles whatever the outgoing phase left running.
  const turned = phase !== state.phase;
  const flushed = turned ? collapse(state) : [];
  const live = turned ? [] : state.live;

  // Verbose settles everything, which is what /verbose is for. Otherwise a line
  // settles if it is output and stays live if it is progress.
  const settle = state.verbose || !phase || KEEP.has(entry.type);
  const settled = settle
    ? [...state.settled, ...flushed, entry]
    : [...state.settled, ...flushed];
  return {
    ...state,
    phase,
    phaseStart: turned ? Date.now() : state.phaseStart,
    // `<Static>` prints each item once and never revisits it, so this array may
    // only ever be appended to — trimming the front would make Ink reprint the
    // whole transcript from wherever the trim landed.
    phaseDone: turned && state.phase
      ? { ...state.phaseDone, [state.phase]: Math.max(0, Math.round((Date.now() - state.phaseStart) / 1000)) }
      : state.phaseDone,
    settled,
    live: settle ? live : [...live, entry].slice(-40),
  };
}
