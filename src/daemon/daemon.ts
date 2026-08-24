// Daemon supervisor (spec §4.1) — owns the named subsystems as in-process
// services with a start/stop lifecycle. The event bus stays in-process (§21.3).
//
//   codemaster-daemon
//   ├── static-analyzer    (continuous watcher)
//   ├── memory-manager     (storage + lifecycle)
//   ├── session-manager    (session lifecycle)
//   ├── provider-manager   (health monitoring)
//   ├── checkpoint-manager (periodic checkpoints)
//   ├── event-bus          (in-process pub/sub)
//   └── cli-server         (command dispatch surface)

import { SessionManager } from './sessionManager.js';
import { CommandRouter } from '../commands/router.js';
import { stopAllWatchers } from '../analysis/watcher.js';
import { loadPlugins } from '../plugins/loader.js';
import { bus } from '../events/bus.js';

export type SubsystemStatus = 'stopped' | 'running';

export class Daemon {
  readonly sm: SessionManager;
  readonly router: CommandRouter;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private status: Record<string, SubsystemStatus> = {
    'static-analyzer': 'stopped',
    'memory-manager': 'stopped',
    'session-manager': 'stopped',
    'provider-manager': 'stopped',
    'checkpoint-manager': 'stopped',
    'event-bus': 'stopped',
    'cli-server': 'stopped',
  };

  constructor() {
    this.sm = new SessionManager();
    this.router = new CommandRouter(this.sm);
  }

  /** Start all subsystems. Returns the count of incomplete sessions detected. */
  async start(): Promise<{ incomplete: number; plugins: number; reaped: number }> {
    if (this.started) return { incomplete: 0, plugins: 0, reaped: 0 };
    this.started = true;

    // event-bus is always live (module singleton).
    this.status['event-bus'] = 'running';
    this.status['memory-manager'] = 'running';
    this.status['session-manager'] = 'running';
    this.status['cli-server'] = 'running';

    // static-analyzer: continuous incremental indexing (spec §5.3).
    this.sm.enableWatching(true);
    this.status['static-analyzer'] = 'running';

    // checkpoint-manager: periodic snapshots (spec §14.3).
    this.sm.startCheckpointTimer();
    this.status['checkpoint-manager'] = 'running';

    // provider-manager: periodic health monitoring (spec §13).
    this.healthTimer = setInterval(() => void this.sm.manager.pingAll(), 30_000);
    if (typeof this.healthTimer.unref === 'function') this.healthTimer.unref();
    this.status['provider-manager'] = 'running';

    const plugins = (await loadPlugins().catch(() => [])).length;
    // Sessions abandoned by an earlier crash are closed out first, so their
    // reasoning reaches long-term memory instead of sitting `active` forever.
    const reaped = (await this.sm.reapStaleSessions().catch(() => [])).length;
    const incomplete = await this.sm.recoverOnStartup().catch(() => 0);
    bus.emit({ type: 'log', level: 'debug', message: 'Daemon subsystems started.' });
    return { incomplete, plugins, reaped };
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.sm.stopCheckpointTimer();
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    await stopAllWatchers();
    for (const k of Object.keys(this.status)) this.status[k] = 'stopped';
    this.started = false;
  }

  subsystems(): Array<{ name: string; status: SubsystemStatus }> {
    return Object.entries(this.status).map(([name, status]) => ({ name, status }));
  }
}
