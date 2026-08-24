// Plugin manifest schema + validation (spec §18.2).

export type PluginType = 'provider' | 'worker' | 'memory' | 'analyzer' | 'command' | 'storage';

export interface PluginManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  type: PluginType;
  entry_point: string;
  requires?: string[];
  config_schema?: Record<string, unknown>;
}

const TYPES: PluginType[] = ['provider', 'worker', 'memory', 'analyzer', 'command', 'storage'];

export function validateManifest(obj: unknown): { ok: boolean; manifest?: PluginManifest; error?: string } {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'manifest is not an object' };
  const m = obj as Record<string, unknown>;
  for (const field of ['id', 'version', 'name', 'type', 'entry_point']) {
    if (typeof m[field] !== 'string') return { ok: false, error: `missing/invalid field: ${field}` };
  }
  if (!TYPES.includes(m.type as PluginType)) return { ok: false, error: `invalid type: ${String(m.type)}` };
  return {
    ok: true,
    manifest: {
      id: m.id as string,
      version: m.version as string,
      name: m.name as string,
      description: (m.description as string) ?? '',
      type: m.type as PluginType,
      entry_point: m.entry_point as string,
      requires: (m.requires as string[]) ?? [],
      config_schema: (m.config_schema as Record<string, unknown>) ?? {},
    },
  };
}

// Core (non-hot-reloadable) plugin types require a restart (spec §18.3).
export function isCoreType(type: PluginType): boolean {
  return type === 'storage' || type === 'provider';
}
