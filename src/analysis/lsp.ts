// LSP integration (spec §5.2.2) — minimal JSON-RPC client over stdio.
// Spawns a language server if installed; degrades gracefully when absent.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

interface ServerSpec {
  cmd: string;
  args: string[];
}

const SERVERS: Record<string, ServerSpec> = {
  python: { cmd: 'pyright-langserver', args: ['--stdio'] },
  typescript: { cmd: 'typescript-language-server', args: ['--stdio'] },
  javascript: { cmd: 'typescript-language-server', args: ['--stdio'] },
  rust: { cmd: 'rust-analyzer', args: [] },
  go: { cmd: 'gopls', args: [] },
};

export interface Location {
  file: string;
  line: number;
  character: number;
}

async function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const r = spawn(process.platform === 'win32' ? 'where' : 'which', [cmd]);
    r.on('close', (code) => resolve(code === 0));
    r.on('error', () => resolve(false));
  });
}

class LspClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private conn: MessageConnection | null = null;
  private ready = false;

  constructor(public readonly repoPath: string, public readonly language: string) {}

  async start(): Promise<boolean> {
    const spec = SERVERS[this.language];
    if (!spec) return false;
    if (!(await commandExists(spec.cmd))) return false;
    try {
      this.proc = spawn(spec.cmd, spec.args, { cwd: this.repoPath });
      this.conn = createMessageConnection(
        new StreamMessageReader(this.proc.stdout),
        new StreamMessageWriter(this.proc.stdin),
      );
      this.conn.listen();
      await this.conn.sendRequest('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(this.repoPath).toString(),
        capabilities: {},
      });
      this.conn.sendNotification('initialized', {});
      this.ready = true;
      return true;
    } catch {
      return false;
    }
  }

  private async openDoc(file: string): Promise<string> {
    // Callers pass repo-relative paths; resolving against cwd instead of the
    // repository made every request throw and silently fall back.
    const abs = path.isAbsolute(file) ? file : path.join(this.repoPath, file);
    const uri = pathToFileURL(abs).toString();
    const text = fs.readFileSync(abs, 'utf8');
    this.conn!.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId: this.language, version: 1, text },
    });
    return uri;
  }

  async definition(file: string, line: number, character: number): Promise<Location[]> {
    if (!this.ready || !this.conn) return [];
    try {
      const uri = await this.openDoc(file);
      const res = (await this.conn.sendRequest('textDocument/definition', {
        textDocument: { uri },
        position: { line: line - 1, character: character - 1 },
      })) as any;
      return normalizeLocations(res);
    } catch {
      return [];
    }
  }

  async references(file: string, line: number, character: number): Promise<Location[]> {
    if (!this.ready || !this.conn) return [];
    try {
      const uri = await this.openDoc(file);
      const res = (await this.conn.sendRequest('textDocument/references', {
        textDocument: { uri },
        position: { line: line - 1, character: character - 1 },
        context: { includeDeclaration: false },
      })) as any;
      return normalizeLocations(res);
    } catch {
      return [];
    }
  }

  async hover(file: string, line: number, character: number): Promise<string> {
    if (!this.ready || !this.conn) return '';
    try {
      const uri = await this.openDoc(file);
      const res = (await this.conn.sendRequest('textDocument/hover', {
        textDocument: { uri },
        position: { line: line - 1, character: character - 1 },
      })) as any;
      const c = res?.contents;
      if (!c) return '';
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x.value)).join('\n');
      return c.value ?? '';
    } catch {
      return '';
    }
  }

  stop(): void {
    try {
      this.conn?.dispose();
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.ready = false;
  }
}

function normalizeLocations(res: any): Location[] {
  if (!res) return [];
  const arr = Array.isArray(res) ? res : [res];
  return arr
    .map((l: any) => {
      const uri: string = l.uri ?? l.targetUri;
      const range = l.range ?? l.targetRange;
      if (!uri || !range) return null;
      return {
        file: uri.replace(/^file:\/\//, ''),
        line: range.start.line + 1,
        character: range.start.character + 1,
      };
    })
    .filter((x: Location | null): x is Location => x !== null);
}

const clients = new Map<string, LspClient>();
// Absence is cached too: without this, a repo whose language server is not
// installed pays a `which` probe for every symbol the selector looks up.
const unavailable = new Set<string>();

export async function lspClient(repoPath: string, language: string): Promise<LspClient | null> {
  const key = `${repoPath}:${language}`;
  const existing = clients.get(key);
  if (existing) return existing;
  if (unavailable.has(key)) return null;
  const client = new LspClient(repoPath, language);
  const ok = await client.start();
  if (!ok) {
    unavailable.add(key);
    return null;
  }
  clients.set(key, client);
  return client;
}

export function stopAllLsp(): void {
  for (const c of clients.values()) c.stop();
  clients.clear();
  unavailable.clear();
}
