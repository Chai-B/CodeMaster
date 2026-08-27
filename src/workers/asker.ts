// Answering a question about the repository, without starting anything.
//
// Every non-slash line used to become a session: a persisted row, a task list,
// and a planning call. "What does resolver.py do?" cost a plan and left state
// behind. This path reuses the same file selection and context compilation the
// solver uses — the retrieval is the expensive, valuable part — and stops at
// one call. Nothing is written: no session, no task, no checkpoint, no wiki.

import { compileContext } from '../context/compiler.js';
import { callLlm } from './llm.js';
import { staticAnalysis } from '../analysis/api.js';
import { namedFiles } from '../context/fileSelector.js';
import { parseObjective } from './intentParser.js';
import { bus } from '../events/bus.js';
import { id, now } from '../util/id.js';
import type { ProviderManager } from '../providers/manager.js';
import type { Config } from '../config.js';
import type { Session, Task } from '../types/index.js';

const ASK_INSTRUCTIONS = `Answer the question about this repository directly and concretely.

Cite the files and symbols you relied on as \`path:line\` so the answer can be checked.
If the context does not contain what the question needs, say exactly what is missing
rather than guessing — a wrong answer about someone's own code is worse than none.

Do not propose edits, do not emit a patch, and do not plan work. This is a question.`;

/** A question is asked far more often than a change is requested, and both
 *  arrive as bare prose. Deliberately narrow: a trailing `?`, or an opening
 *  word that only ever starts a question. "Fix the parser?" is still a change,
 *  so an imperative opener wins over the question mark. */
const INTERROGATIVE = /^(what|why|how|where|when|which|who|whose|does|do|did|is|are|was|can|could|should|would|explain|describe|summarise|summarize|tell)\b/i;
const IMPERATIVE = /^(fix|add|implement|refactor|write|create|remove|delete|rename|update|migrate|build|make|port|optimi[sz]e|test)\b/i;

export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t || t.startsWith('/')) return false;
  if (IMPERATIVE.test(t)) return false;
  return t.endsWith('?') || INTERROGATIVE.test(t);
}

/** Session and Task shaped for the compiler, never handed to storage. The
 *  compiler reads a repository path, a task type and keywords off them; giving
 *  it the real shapes means the ask path gets the same retrieval as the solver
 *  instead of a second, weaker one that would drift. */
function ephemeral(question: string, repoPath: string, commit: string): { session: Session; task: Task } {
  const session: Session = {
    id: id('ask'),
    created_at: now(),
    updated_at: now(),
    status: 'active',
    objective: question,
    objective_parsed: parseObjective(question),
    repository: { path: repoPath, commit },
    progress: { total: 0, completed: 0, failed: 0 },
    constraints: [],
    open_questions: [],
    working_files: [],
    decisions: [],
    provider_history: [],
    checkpoints: [],
    token_usage: { total_input: 0, total_output: 0, total: 0, by_provider: {}, cost_usd: 0 },
    metadata: {},
  };
  const task: Task = {
    id: id('task'),
    session_id: session.id,
    title: question.slice(0, 80),
    description: question,
    // Reviewing is what answering a question is: read the code, say what is
    // true about it. The review profile weights source and structure over the
    // planning components a question has no use for.
    type: 'review',
    status: 'in_progress',
    input_files: namedFiles(repoPath, question).map((path) => ({ path })),
    output_files: [],
    dependencies: [],
    blocking: [],
    reasoning_refs: [],
    decision_refs: [],
    estimated_tokens: 0,
    order: 0,
  };
  return { session, task };
}

export async function answerQuestion(
  question: string,
  repoPath: string,
  manager: ProviderManager,
  cfg: Config,
): Promise<{ text: string; tokens: number; model: string }> {
  const api = staticAnalysis(repoPath);
  const commit = (await api.git.isRepo()) ? await api.git.headCommit() : 'no-git';
  const { session, task } = ephemeral(question, repoPath, commit);

  bus.emit({ type: 'worker.started', worker: 'Asker', detail: 'selecting files' });
  const model = manager.modelFor('solve');
  const compiled = await compileContext(session, task, {
    maxContextTokens: manager.select(model, cfg.context.max_context_tokens).spec.context_size,
    fileCompressionThreshold: cfg.context.file_compression_threshold,
    taskInstructions: ASK_INSTRUCTIONS,
  });

  // The answer IS the deliverable here, so it goes to the solve model rather
  // than one of the cheap mechanical roles.
  const { text, tokens } = await callLlm(manager, cfg, {
    role: 'solve',
    system: compiled.system,
    user: compiled.body,
    sessionId: session.id,
    taskId: task.id,
  });
  bus.emit({ type: 'worker.finished', worker: 'Asker', detail: `${tokens} tokens` });
  return { text, tokens, model };
}
