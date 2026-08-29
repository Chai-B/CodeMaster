// Command catalog (spec §17.2).

export interface CommandDef {
  cmd: string;
  desc: string;
  group: string;
  /** Full call form, shown by `/<cmd> --help`. Absent means the command takes
   *  no arguments. */
  usage?: string;
}

export const COMMANDS: CommandDef[] = [
  // Session
  { cmd: '/ask', desc: 'Answer a question about the repository, read-only', group: 'Session', usage: '/ask <question>' },
  { cmd: '/new', desc: 'Create a session with an objective', group: 'Session', usage: '/new <objective>' },
  { cmd: '/resume', desc: 'Resume a paused/crashed session', group: 'Session', usage: '/resume [session_id]' },
  { cmd: '/recover', desc: 'Recover incomplete sessions after a crash', group: 'Session' },
  { cmd: '/pause', desc: 'Pause current session (checkpoint)', group: 'Session' },
  { cmd: '/complete', desc: 'Complete current session', group: 'Session' },
  { cmd: '/session', desc: 'List or show sessions', group: 'Session', usage: '/session | /session info <session_id>' },
  { cmd: '/projects', desc: 'List every repository CodeMaster has state for', group: 'Session' },
  // Planning
  { cmd: '/plan', desc: '(Re)generate the execution plan', group: 'Planning' },
  { cmd: '/tasks', desc: 'Show current task list', group: 'Planning' },
  { cmd: '/task', desc: 'Show detail for a task', group: 'Planning', usage: '/task <task index|id>' },
  { cmd: '/run', desc: 'Execute the next pending task', group: 'Planning' },
  { cmd: '/runall', desc: 'Execute all pending tasks', group: 'Planning' },
  { cmd: '/skip', desc: 'Mark a task as skipped', group: 'Planning', usage: '/skip <task index|id>' },
  // Provider
  { cmd: '/model', desc: 'Show or switch the model in use', group: 'Provider', usage: '/model | /model <model_id>' },
  { cmd: '/provider', desc: 'List/use/status providers', group: 'Provider', usage: '/provider | /provider use <model_id>' },
  { cmd: '/account', desc: 'Hold several vendors\' keys and choose which answers', group: 'Provider', usage: '/account | /account add <provider> <alias> <key> | /account use <alias> | /account remove <alias>' },
  { cmd: '/handoff', desc: 'Hand off session to a provider', group: 'Provider', usage: '/handoff <model_id>' },
  // Memory / Wiki
  { cmd: '/memory', desc: 'Inspect/search memory', group: 'Memory', usage: '/memory | /memory compress' },
  { cmd: '/wiki', desc: 'Show/search/update wiki', group: 'Memory', usage: '/wiki [key] | /wiki bootstrap | /wiki update <key>' },
  { cmd: '/reasoning', desc: 'Browse reasoning objects', group: 'Memory', usage: '/reasoning | /reasoning search <query>' },
  { cmd: '/forget', desc: 'Mark memories for expiry', group: 'Memory', usage: '/forget <query>' },
  // Repository
  { cmd: '/reindex', desc: 'Full repository re-index', group: 'Repository' },
  { cmd: '/rebuild-map', desc: 'Regenerate repository map', group: 'Repository' },
  { cmd: '/graph', desc: 'Show dependency graph for a module', group: 'Repository', usage: '/graph <file> | cycles | deadcode | rkg | untested' },
  // Checkpoint
  { cmd: '/checkpoint', desc: 'Create a checkpoint', group: 'Checkpoint' },
  { cmd: '/checkpoints', desc: 'List, restore or diff checkpoints', group: 'Checkpoint', usage: '/checkpoints | /checkpoints restore <checkpoint_id> | /checkpoints diff <checkpoint_id>' },
  { cmd: '/undo', desc: 'Take back the last applied change', group: 'Checkpoint', usage: '/undo | /undo list' },
  { cmd: '/diff', desc: 'Show what this session changed on disk', group: 'Checkpoint', usage: '/diff | /diff full' },
  // Diagnostic
  { cmd: '/tokens', desc: 'Token usage statistics', group: 'Diagnostic', usage: '/tokens | /tokens by-provider' },
  { cmd: '/context', desc: 'Show compiled context (no LLM)', group: 'Diagnostic' },
  { cmd: '/stats', desc: 'Tokens, cost, context window and quality — and what was saved', group: 'Diagnostic' },
  { cmd: '/doctor', desc: 'Check that everything is set up correctly', group: 'Diagnostic' },
  { cmd: '/health', desc: 'Provider account health', group: 'Diagnostic' },
  { cmd: '/cost', desc: 'Subscription windows spent and blocked', group: 'Diagnostic' },
  { cmd: '/waste', desc: 'Where tokens went that bought no reasoning', group: 'Diagnostic' },
  { cmd: '/why', desc: 'Why a file is in the context', group: 'Diagnostic', usage: '/why <file>' },
  { cmd: '/learn', desc: 'What this repository has taught the selector', group: 'Diagnostic' },
  { cmd: '/workers', desc: 'List workers + task pipeline', group: 'Diagnostic' },
  { cmd: '/profile', desc: 'Profiling for a task', group: 'Diagnostic', usage: '/profile <task index|id>' },
  { cmd: '/replay', desc: 'Replay reasoning from a session', group: 'Diagnostic', usage: '/replay <session_id>' },
  { cmd: '/verbose', desc: 'Toggle verbose worker trace', group: 'Diagnostic', usage: '/verbose [on|off]' },
  // Misc
  { cmd: '/config', desc: 'Show or change settings', group: 'Misc', usage: '/config | /config set <key> <value>' },
  { cmd: '/plugins', desc: 'List loaded plugins', group: 'Misc' },
  { cmd: '/help', desc: 'Show commands', group: 'Misc', usage: '/help | /help <group> | /help <command>' },
  { cmd: '/clear', desc: 'Clear the screen', group: 'Misc' },
  { cmd: '/quit', desc: 'Exit CodeMaster (alias /exit)', group: 'Misc' },
];
