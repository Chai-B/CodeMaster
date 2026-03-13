import stripAnsi from 'strip-ansi';

export type LogType = 'plain' | 'tool' | 'success' | 'error' | 'warn' | 'dim' | 'heading' | 'sep' | 'user';

export interface LogEntry { id: number; type: LogType; text: string }

export interface Metrics {
  calls: number;
  total_tokens: number;
  elapsed: number;
  avg_context: number;
}

const METRICS_PREFIX = 'CM_METRICS:';

export function parseMetrics(raw: string): Metrics | null {
  const line = stripAnsi(raw).trim();
  if (!line.startsWith(METRICS_PREFIX)) return null;
  try { return JSON.parse(line.slice(METRICS_PREFIX.length)); } catch { return null; }
}

export function classifyLine(raw: string): Omit<LogEntry, 'id'> {
  const line = stripAnsi(raw).trim();
  if (!line || line.startsWith(METRICS_PREFIX)) return { type: 'plain', text: '' };

  // Section headers: ── CODER ──
  if (/^──\s+[A-Z]/.test(line)) return { type: 'heading', text: line.replace(/^──\s+|\s+──$/g, '') };

  // Separators: ─── or ───
  if (/^[─━─]+$/.test(line)) return { type: 'sep', text: '' };

  // Token accounting lines
  if (/^\(tokens\)/.test(line)) return { type: 'dim', text: line };

  // Success
  if (/^[✓✔]|^Applied:|^Modified:|^Created:/.test(line)) return { type: 'success', text: line.replace(/^[✓✔]\s*/, '') };

  // Errors
  if (/^[✗✘]|^Error:/.test(line)) return { type: 'error', text: line.replace(/^[✗✘]\s*/, '') };

  // Warnings
  if (/^[⚠]|^Warning:/.test(line)) return { type: 'warn', text: line.replace(/^⚠\s*/, '') };

  // Diff output (show as-is, distinct type)
  if (/^(---|\+\+\+|@@|[-+] )/.test(line)) return { type: 'tool', text: line };

  // Tool/pipeline activity
  if (/^(Found|Searching|Refreshing|Calling|Claude|Building|Scoring|Simulating|Minimizing|Review|Patch|Step\s+\d|→)/.test(line)) return { type: 'tool', text: line };

  return { type: 'plain', text: line };
}

