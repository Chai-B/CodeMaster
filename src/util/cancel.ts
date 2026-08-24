// Task cancellation (spec §17 CLI). Ctrl-C during a run should stop the task,
// not the process — a killed process loses the session's in-memory state and
// the work already applied to the tree.
//
// The vendor CLIs are driven with spawnSync, which blocks the event loop and
// cannot be interrupted from JavaScript. That is fine: the child shares the
// terminal's process group, so Ctrl-C reaches it directly and the adapter sees
// a signalled child. What this module adds is everything after that — the
// solver, the executor and the failover loop stop instead of retrying into a
// cancellation.

export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'Cancelled';
  }
}

let controller: AbortController | null = null;

/** Begin a cancellable run. Returns the signal for anything that can use one. */
export function beginCancellable(): AbortSignal {
  controller = new AbortController();
  return controller.signal;
}

export function endCancellable(): void {
  controller = null;
}

/** True when a run was active and has now been asked to stop. */
export function cancelActive(): boolean {
  if (!controller || controller.signal.aborted) return false;
  controller.abort();
  return true;
}

export function isCancelled(): boolean {
  return !!controller?.signal.aborted;
}

export function throwIfCancelled(): void {
  if (isCancelled()) throw new Cancelled();
}
