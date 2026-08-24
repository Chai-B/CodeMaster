#!/usr/bin/env node
// CodeMaster Next launcher — runs the TypeScript entry via the bundled tsx CLI.
// Works from a global install with no network access (no `npx`).

import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src', 'index.tsx');

// `--version` without paying tsx/Ink startup.
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

// Resolve the tsx CLI shipped as a dependency of this package.
function resolveTsxCli() {
  try {
    const pkgPath = require.resolve('tsx/package.json');
    const dir = path.dirname(pkgPath);
    const binField = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).bin;
    const rel = typeof binField === 'string' ? binField : binField.tsx;
    return path.join(dir, rel);
  } catch {
    return null;
  }
}

const cli = resolveTsxCli();
const result = cli
  ? spawnSync(process.execPath, [cli, target, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
  : spawnSync('npx', ['tsx', target, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });

process.exit(result.status ?? 0);
