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
