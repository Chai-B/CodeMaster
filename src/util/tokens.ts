// Deterministic token estimation (~4 chars/token heuristic).

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** A duration in words. Used for "spent 12m ago" and "resets in 3h 20m", where
 *  a bare ISO timestamp makes the reader do the arithmetic. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** How long ago, from an ISO timestamp. */
export function fmtAgo(iso: string | undefined): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'never';
  return `${fmtDuration(Date.now() - t)} ago`;
}

export function fmtCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'in', 'of', 'for', 'on', 'with', 'is', 'are',
  'be', 'this', 'that', 'it', 'as', 'at', 'by', 'from', 'into', 'add', 'make', 'use',
  'using', 'should', 'would', 'can', 'will', 'we', 'i', 'how', 'what', 'when',
]);

export function keywords(text: string, max = 12): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_\s/.]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}
