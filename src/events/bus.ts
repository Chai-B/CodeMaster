// In-process typed pub/sub event bus (spec §21.3).

import { EventEmitter } from 'events';
import { loadConfig } from '../config.js';
import type { CodeMasterEvent, EventType } from './types.js';

type Listener = (event: CodeMasterEvent) => void;

// `daemon.log_level` was inert — every debug line reached every subscriber
// regardless of the setting. Ordered least to most verbose.
const LEVELS = ['error', 'warn', 'success', 'info', 'debug'];

class EventBus {
  private emitter = new EventEmitter();
  private wildcard = new Set<Listener>();
  private threshold: number | null = null;

  private suppressed(event: CodeMasterEvent): boolean {
    if (event.type !== 'log') return false;
    if (this.threshold === null) this.threshold = LEVELS.indexOf(loadConfig().daemon.log_level);
    return this.threshold >= 0 && LEVELS.indexOf(event.level) > this.threshold;
  }

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: CodeMasterEvent): void {
    if (this.suppressed(event)) return;
    this.emitter.emit(event.type, event);
    for (const l of this.wildcard) l(event);
  }

  on(type: EventType, listener: Listener): () => void {
    this.emitter.on(type, listener);
    return () => this.emitter.off(type, listener);
  }

  /** Subscribe to every event. Returns an unsubscribe function. */
  onAny(listener: Listener): () => void {
    this.wildcard.add(listener);
    return () => this.wildcard.delete(listener);
  }

  // Convenience emitters
  log(level: 'info' | 'warn' | 'error' | 'debug' | 'success', message: string): void {
    this.emit({ type: 'log', level, message });
  }

  worker(worker: string, detail?: string): void {
    this.emit({ type: 'worker.started', worker, detail });
  }
}

export const bus = new EventBus();
export type { EventBus };
