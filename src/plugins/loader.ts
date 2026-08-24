// Plugin loader (spec §18) — loads plugins from ~/.codemaster/plugins/.
// Extension points: provider, worker, memory, analyzer, command, storage.

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { DATA_DIR } from '../config.js';
import { registerWorker, type Worker } from '../workers/base.js';
import { bus } from '../events/bus.js';
import { validateManifest, type PluginManifest } from './manifest.js';

export const PLUGINS_DIR = path.join(DATA_DIR, 'plugins');

export interface CommandPlugin {
  command: string;
  description: string;
  run(args: string[], emit: (level: string, msg: string) => void): Promise<void> | void;
}

export interface AnalyzerPlugin {
  name: string;
  analyze(repoPath: string): Promise<unknown> | unknown;
}

export interface PluginModule {
  worker?: Worker<any, any>;
  command?: CommandPlugin;
  analyzer?: AnalyzerPlugin;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  module: PluginModule;
}

const loaded = new Map<string, LoadedPlugin>();
const commandPlugins = new Map<string, CommandPlugin>();
const analyzerPlugins = new Map<string, AnalyzerPlugin>();

export async function loadPlugins(): Promise<LoadedPlugin[]> {
  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    return [];
  }
  const dirs = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  const out: LoadedPlugin[] = [];
  for (const d of dirs) {
    const plugin = await loadOne(path.join(PLUGINS_DIR, d.name));
    if (plugin) out.push(plugin);
  }
  return out;
}

async function loadOne(dir: string): Promise<LoadedPlugin | null> {
  const manifestPath = path.join(dir, 'plugin.json');
  if (!fs.existsSync(manifestPath)) return null;
  let manifest: PluginManifest;
  try {
    const v = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    if (!v.ok || !v.manifest) {
      bus.emit({ type: 'log', level: 'warn', message: `Plugin ${path.basename(dir)}: ${v.error}` });
      return null;
    }
    manifest = v.manifest;
  } catch (e) {
    bus.emit({ type: 'log', level: 'warn', message: `Plugin ${path.basename(dir)}: bad manifest (${String(e)})` });
    return null;
  }

  try {
    const entry = path.join(dir, manifest.entry_point);
    const mod = (await import(pathToFileURL(entry).toString())) as PluginModule;
    if (mod.worker) registerWorker(mod.worker);
    if (mod.command) commandPlugins.set(mod.command.command, mod.command);
    if (mod.analyzer) analyzerPlugins.set(mod.analyzer.name, mod.analyzer);
    const lp: LoadedPlugin = { manifest, module: mod };
    loaded.set(manifest.id, lp);
    bus.emit({ type: 'log', level: 'success', message: `Plugin loaded: ${manifest.name} (${manifest.type})` });
    return lp;
  } catch (e) {
    bus.emit({ type: 'log', level: 'error', message: `Plugin ${manifest.id} failed to load: ${String(e)}` });
    return null;
  }
}

export function listPlugins(): PluginManifest[] {
  return [...loaded.values()].map((p) => p.manifest);
}

export function getCommandPlugin(cmd: string): CommandPlugin | undefined {
  return commandPlugins.get(cmd);
}

export function listCommandPlugins(): CommandPlugin[] {
  return [...commandPlugins.values()];
}

export function getAnalyzerPlugin(name: string): AnalyzerPlugin | undefined {
  return analyzerPlugins.get(name);
}
