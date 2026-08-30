// Handing the terminal to another program, and taking it back.
//
// The TUI owns the alternate screen and holds stdin in raw mode. A vendor's own
// `login` draws its own interface, opens a browser and reads its own keys, so
// it needs both — and needs them returned afterwards. The TUI installs the
// handover when it mounts; headless, MCP and proxy runs leave the default,
// which just runs the child on the terminal they already have.

export type Suspender = <T>(run: () => T | Promise<T>) => Promise<T>;

let suspender: Suspender | null = null;

export function setSuspender(fn: Suspender | null): void {
  suspender = fn;
}

export async function withTerminal<T>(run: () => T | Promise<T>): Promise<T> {
  return suspender ? await suspender(run) : await run();
}
