// Task cancellation (spec §17 CLI). Ctrl-C during a run should stop the task,
// not the process — a killed process loses the session's in-memory state and
// the work already applied to the tree.
//
// The vendor CLIs run as ordinary async children (see providers/cliRun.ts),
// which poll `isCancelled` and send the child SIGINT — so a cancelled run stops
// the vendor call itself rather than waiting for it to finish. What this module
// adds beyond that is everything after: the solver, the executor and the
// failover loop stop instead of retrying into a cancellation.

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
