// Incremental indexing pipeline (spec §5.3) — chokidar file watching.

import chokidar, { type FSWatcher } from 'chokidar';
import path from 'path';
import { indexFile } from './indexer.js';
import { languageOf } from './extractors.js';
import { dependencyGraph } from './depGraph.js';
import { bus } from '../events/bus.js';

const IGNORED = /(^|[\/\\])(node_modules|\.git|dist|build|\.codemaster|\.next|__pycache__|target|\.venv|venv)([\/\\]|$)/;

const watchers = new Map<string, FSWatcher>();

export function startWatching(repoPath: string): void {
  if (watchers.has(repoPath)) return;
  const watcher = chokidar.watch(repoPath, {
    ignored: IGNORED,
    ignoreInitial: true,
    persistent: true,
    depth: 12,
  });

  const onChange = async (full: string, change: 'created' | 'modified' | 'deleted') => {
    if (!languageOf(full)) return;
    const rel = path.relative(repoPath, full);
    await indexFile(repoPath, rel);
    dependencyGraph(repoPath, true); // rebuild graph cache
    bus.emit({ type: 'repository.file.changed', path: rel, change_type: change });
    bus.emit({ type: 'repository.index.updated', changed_files: [rel] });
  };

  watcher
    .on('add', (f) => void onChange(f, 'created'))
    .on('change', (f) => void onChange(f, 'modified'))
    .on('unlink', (f) => void onChange(f, 'deleted'));

  watchers.set(repoPath, watcher);
}

export async function stopWatching(repoPath: string): Promise<void> {
  const w = watchers.get(repoPath);
  if (w) {
    await w.close();
    watchers.delete(repoPath);
  }
}

export async function stopAllWatchers(): Promise<void> {
  for (const [, w] of watchers) await w.close();
  watchers.clear();
}
