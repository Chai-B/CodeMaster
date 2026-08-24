// Example command plugin (spec §18). Copy this folder into ~/.codemaster/plugins/ to enable.
import { spawnSync } from 'child_process';

export const command = {
  command: '/todos',
  description: 'Scan for TODO/FIXME/HACK comments',
  run(args, emit) {
    emit('heading', 'TODOs');
    const r = spawnSync('grep', ['-rEn', '--exclude-dir=node_modules', '--exclude-dir=.git', 'TODO|FIXME|HACK', process.cwd()], { encoding: 'utf8' });
    const lines = (r.stdout || '').split('\n').filter(Boolean).slice(0, 50);
    if (!lines.length) { emit('info', 'No TODOs found.'); return; }
    for (const l of lines) emit('info', l.slice(0, 160));
  },
};
