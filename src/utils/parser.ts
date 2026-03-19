import stripAnsi from 'strip-ansi';

export type LogType = 'plain' | 'tool' | 'success' | 'error' | 'warn' | 'dim' | 'heading' | 'sep' | 'user' | 'step' | 'nested' | 'nested2';

export interface LogEntry { id: number; type: LogType; text: string }

export interface Metrics {
  calls: number;
  total_tokens: number;
  elapsed: number;
  avg_context: number;
}

const METRICS_PREFIX = 'CM_METRICS:';
const DIFF_PREFIX = 'CM_DIFF:';

export function parseMetrics(raw: string): Metrics | null {
  const line = stripAnsi(raw).trim();
  if (!line.startsWith(METRICS_PREFIX)) return null;
  try { return JSON.parse(line.slice(METRICS_PREFIX.length)); }
  catch { return null; }
}

export function isDiffLine(raw: string): boolean {
  return stripAnsi(raw).trim().startsWith(DIFF_PREFIX);
}

export function extractDiffLine(raw: string): string {
  return stripAnsi(raw).trim().slice(DIFF_PREFIX.length);
}

export function classifyLine(raw: string): Omit<LogEntry, 'id'> {
  const clean = stripAnsi(raw);
  const trimmed = clean.trim();
  if (!trimmed || trimmed.startsWith(METRICS_PREFIX) || trimmed.startsWith(DIFF_PREFIX))
    return { type: 'plain', text: '' };

  // Step marker: ⏺ NAME
  if (trimmed.startsWith('⏺')) return { type: 'step', text: trimmed.slice(1).trim() };

  // Deep nested: 4+ spaces then ⎿
  if (/^\s{4,}⎿/.test(clean)) {
    const text = trimmed.replace(/^⎿\s*/, '');
    if (/^✓/.test(text)) return { type: 'success', text: text.slice(1).trim() };
    if (/^✗/.test(text)) return { type: 'error', text: text.slice(1).trim() };
    if (/^⚠/.test(text)) return { type: 'warn', text: text.slice(1).trim() };
    return { type: 'nested2', text };
  }

  // Nested: 1-3 spaces then ⎿
  if (/^\s{1,3}⎿/.test(clean)) {
    const text = trimmed.replace(/^⎿\s*/, '');
    if (/^✓/.test(text)) return { type: 'success', text: text.slice(1).trim() };
    if (/^✗/.test(text)) return { type: 'error', text: text.slice(1).trim() };
    if (/^⚠/.test(text)) return { type: 'warn', text: text.slice(1).trim() };
    if (/^[→←]/.test(text)) return { type: 'tool', text };
    return { type: 'nested', text };
  }

  // Legacy format: ── HEADING ──
  if (/^──\s+[A-Z]/.test(trimmed)) return { type: 'step', text: trimmed.replace(/^──\s+|\s+──$/g, '') };

  // Legacy separators
  if (/^[─━]+$/.test(trimmed)) return { type: 'sep', text: '' };

  // Legacy: standalone success/error/warn
  if (/^[✓✔]/.test(trimmed)) return { type: 'success', text: trimmed.replace(/^[✓✔]\s*/, '') };
  if (/^[✗✘]|^Error:/.test(trimmed)) return { type: 'error', text: trimmed.replace(/^[✗✘]\s*/, '') };
  if (/^[⚠]|^Warning:/.test(trimmed)) return { type: 'warn', text: trimmed.replace(/^⚠\s*/, '') };

  // Agent call arrows (legacy)
  if (/^[→←]/.test(trimmed)) return { type: 'tool', text: trimmed };

  // Diff output (legacy)
  if (/^(---|\+\+\+|@@|[-+] )/.test(trimmed)) return { type: 'tool', text: trimmed };

  // Activity keywords → nested style
  if (/^(Found|Searching|Scanning|Calling|Claude|Building|Expanding|Scoring|Simulating|Minimizing|Running|Applying|Task type|Description|Keywords|Context:|Dependencies:|Simulation:|Final:|Loading)/.test(trimmed))
    return { type: 'nested', text: trimmed };

  return { type: 'plain', text: trimmed };
}
