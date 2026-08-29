// Interactive prompts, asked by commands and drawn by whatever is in front of
// the user.
//
// The router runs in the same process as the TUI, so this is a module-level
// hook rather than a channel: the TUI installs a prompter when it mounts, and
// headless, MCP and proxy runs leave the default. The default answers `null`,
// which every caller must treat as "not asked" and fall back to the usage line
// it printed before — a command must never become unusable from a script
// because it grew a picker.

export interface Choice {
  value: string;
  label: string;
  hint?: string;
}

export interface Field {
  name: string;
  label: string;
  /** Never echoed and never kept: shown as dots, and the caller is expected to
   *  consume it immediately rather than log it. */
  secret?: boolean;
  choices?: Choice[];
  placeholder?: string;
}

export type PromptSpec =
  | { kind: 'select'; title: string; choices: Choice[] }
  | { kind: 'confirm'; title: string; detail?: string; danger?: boolean }
  | { kind: 'form'; title: string; fields: Field[] };

export type PromptResult = string | boolean | Record<string, string>;

export type Prompter = (spec: PromptSpec) => Promise<PromptResult | null>;

let prompter: Prompter | null = null;

export function setPrompter(fn: Prompter | null): void {
  prompter = fn;
}

/** Whether there is anyone to ask. Commands use this to choose between a
 *  picker and the line of usage text they would otherwise print. */
export function interactive(): boolean {
  return prompter !== null;
}

export async function select(title: string, choices: Choice[]): Promise<string | null> {
  if (!prompter || !choices.length) return null;
  const r = await prompter({ kind: 'select', title, choices });
  return typeof r === 'string' ? r : null;
}

export async function confirm(
  title: string,
  opts: { detail?: string; danger?: boolean } = {},
): Promise<boolean | null> {
  if (!prompter) return null;
  const r = await prompter({ kind: 'confirm', title, ...opts });
  return typeof r === 'boolean' ? r : null;
}

export async function form(title: string, fields: Field[]): Promise<Record<string, string> | null> {
  if (!prompter || !fields.length) return null;
  const r = await prompter({ kind: 'form', title, fields });
  return r !== null && typeof r === 'object' ? r : null;
}
