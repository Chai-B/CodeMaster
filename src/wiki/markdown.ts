// Wiki ↔ markdown file mirroring with front-matter (spec §9.2, §9.5).

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { wikiDir } from '../config.js';
import type { WikiEntry, WikiFrontMatter } from '../types/index.js';

export function wikiFilePath(key: string): string {
  return path.join(wikiDir(), `${key}.md`);
}

export function renderEntry(entry: WikiEntry): string {
  const fm = yaml.dump(entry.front_matter).trimEnd();
  return `---\n${fm}\n---\n\n${entry.content_markdown}\n`;
}

export function writeMarkdown(entry: WikiEntry): void {
  const fp = wikiFilePath(entry.wiki_key);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, renderEntry(entry), 'utf8');
}

export function writeVersion(key: string, content: string, stamp: string): void {
  const dir = path.join(wikiDir(), '.versions', key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${stamp.replace(/[:.]/g, '')}.md`), content, 'utf8');
}

export function parseMarkdown(raw: string): { front_matter: Partial<WikiFrontMatter>; content: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return { front_matter: {}, content: raw };
  let fm: Partial<WikiFrontMatter> = {};
  try {
    fm = (yaml.load(m[1]!) as Partial<WikiFrontMatter>) ?? {};
  } catch {
    fm = {};
  }
  return { front_matter: fm, content: (m[2] ?? '').trim() };
}
