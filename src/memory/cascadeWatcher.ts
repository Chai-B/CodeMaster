// CascadeWatcher — watches .codemaster/memory/ markdown vault for developer edits (EverOS pattern).
// When markdown files in the memory vault are manually edited or added, cascades the changes
// back into SQLite and the FTS5 index.

import fs from 'fs';
import path from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import { Skills } from './skills.js';
import { LongTerm } from '../storage/memory.js';
import { id, now } from '../util/id.js';

export interface MemoryWatcherHandle {
  close: () => Promise<void>;
}

export function startMemoryWatcher(repoPath: string): MemoryWatcherHandle {
  const memoryDir = path.join(repoPath, '.codemaster', 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  const watcher: FSWatcher = chokidar.watch(memoryDir, {
    ignored: /(^|[/\\])\../, // ignore dotfiles
    persistent: false,
    ignoreInitial: true,
  });

  const handleFileChange = (filePath: string): void => {
    if (!filePath.endsWith('.md')) return;

    // Check if it is inside skills/
    if (filePath.includes(path.join('.codemaster', 'memory', 'skills'))) {
      try {
        Skills.syncFromDisk(repoPath);
      } catch {
        /* best effort */
      }
      return;
    }

    // Otherwise, generic markdown file (e.g. conventions.md, architecture.md)
    try {
      const rel = path.relative(memoryDir, filePath);
      const namespace = path.dirname(rel) === '.' ? 'vault' : path.dirname(rel);
      const key = path.basename(rel, '.md');
      const content = fs.readFileSync(filePath, 'utf8');

      LongTerm.upsert({
        id: id('memory'),
        namespace,
        key,
        value_json: JSON.stringify({ markdown: content }),
        value_markdown: content,
        importance: 0.8,
        confidence: 1.0,
        created_at: now(),
        updated_at: now(),
        tags: ['vault', namespace],
        permanent: true,
      });
    } catch {
      /* best effort */
    }
  };

  watcher.on('add', handleFileChange);
  watcher.on('change', handleFileChange);

  return {
    close: async () => {
      await watcher.close();
    },
  };
}
