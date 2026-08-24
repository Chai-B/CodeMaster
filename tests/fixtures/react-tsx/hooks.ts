export function formatLabel(raw: string): string {
  return raw.trim().toUpperCase();
}

export function classNames(...parts: string[]): string {
  return parts.filter(Boolean).join(' ');
}
