// In-process typed pub/sub event bus (spec §21.3).

import { EventEmitter } from 'events';
import type { CodeMasterEvent, EventType } from './types.js';

type Listener = (event: CodeMasterEvent) => void;

class EventBus {
  private emitter = new EventEmitter();
  private wildcard = new Set<Listener>();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: CodeMasterEvent): void {
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
