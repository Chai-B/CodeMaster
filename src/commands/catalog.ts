// Command catalog (spec §17.2).

export interface CommandDef {
  cmd: string;
  desc: string;
  group: string;
}

export const COMMANDS: CommandDef[] = [
  // Session
  { cmd: '/new', desc: 'Create a session with an objective', group: 'Session' },
  { cmd: '/resume', desc: 'Resume a paused/crashed session', group: 'Session' },
  { cmd: '/recover', desc: 'Recover incomplete sessions after a crash', group: 'Session' },
  { cmd: '/pause', desc: 'Pause current session (checkpoint)', group: 'Session' },
  { cmd: '/complete', desc: 'Complete current session', group: 'Session' },
  { cmd: '/session', desc: 'List or show sessions', group: 'Session' },
  // Planning
  { cmd: '/plan', desc: '(Re)generate the execution plan', group: 'Planning' },
  { cmd: '/tasks', desc: 'Show current task list', group: 'Planning' },
  { cmd: '/task', desc: 'Show detail for a task', group: 'Planning' },
  { cmd: '/run', desc: 'Execute the next pending task', group: 'Planning' },
  { cmd: '/runall', desc: 'Execute all pending tasks', group: 'Planning' },
  { cmd: '/skip', desc: 'Mark a task as skipped', group: 'Planning' },
  // Provider
  { cmd: '/provider', desc: 'List/use/status providers', group: 'Provider' },
  { cmd: '/account', desc: 'Manage provider accounts', group: 'Provider' },
  { cmd: '/handoff', desc: 'Hand off session to a provider', group: 'Provider' },
  // Memory / Wiki
  { cmd: '/memory', desc: 'Inspect/search memory', group: 'Memory' },
  { cmd: '/wiki', desc: 'Show/search/update wiki', group: 'Memory' },
  { cmd: '/reasoning', desc: 'Browse reasoning objects', group: 'Memory' },
  { cmd: '/forget', desc: 'Mark memories for expiry', group: 'Memory' },
  // Repository
  { cmd: '/reindex', desc: 'Full repository re-index', group: 'Repository' },
  { cmd: '/rebuild-map', desc: 'Regenerate repository map', group: 'Repository' },
  { cmd: '/graph', desc: 'Show dependency graph for a module', group: 'Repository' },
  // Checkpoint
  { cmd: '/checkpoint', desc: 'Create a checkpoint', group: 'Checkpoint' },
  { cmd: '/checkpoints', desc: 'List/restore checkpoints', group: 'Checkpoint' },
  // Diagnostic
  { cmd: '/tokens', desc: 'Token usage statistics', group: 'Diagnostic' },
  { cmd: '/context', desc: 'Show compiled context (no LLM)', group: 'Diagnostic' },
  { cmd: '/stats', desc: 'Overall runtime statistics', group: 'Diagnostic' },
  { cmd: '/health', desc: 'Provider account health', group: 'Diagnostic' },
  { cmd: '/workers', desc: 'List workers + task pipeline', group: 'Diagnostic' },
  { cmd: '/profile', desc: 'Profiling for a task', group: 'Diagnostic' },
  { cmd: '/replay', desc: 'Replay reasoning from a session', group: 'Diagnostic' },
  { cmd: '/verbose', desc: 'Toggle verbose worker trace', group: 'Diagnostic' },
  // Misc
  { cmd: '/plugins', desc: 'List loaded plugins', group: 'Misc' },
  { cmd: '/help', desc: 'Show commands', group: 'Misc' },
  { cmd: '/clear', desc: 'Clear the screen', group: 'Misc' },
  { cmd: '/quit', desc: 'Exit CodeMaster', group: 'Misc' },
];
