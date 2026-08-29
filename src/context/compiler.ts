// ContextCompiler — assembles the optimal prompt from structured state (spec §10).
// Never reads conversation history. Deterministic. Never calls an LLM.

import yaml from 'js-yaml';
import { staticAnalysis } from '../analysis/api.js';
import { selectFiles } from './fileSelector.js';
import { resolveBudget } from './budget.js';
import { Learning } from '../learning/reflector.js';
import { readRelevantSections, readConventions, readArchitecture } from '../wiki/reader.js';
import { Reasoning, Failures } from '../storage/reasoning.js';
import { LongTerm } from '../storage/memory.js';
import { OUTPUT_FORMAT, SYSTEM_PROMPT, PROSE_OUTPUT_FORMAT, PROSE_SYSTEM_PROMPT } from './outputFormat.js';
import { estimateTokens } from '../util/tokens.js';
import { now } from '../util/id.js';
import { ContextComponent } from '../types/index.js';
import type { Session, Task, CompiledPrompt, CompiledComponent } from '../types/index.js';

const C = ContextComponent;

export interface CompileOptions {
  maxContextTokens: number;
  fileCompressionThreshold: number;
  conflictKeywords?: string[];
  taskInstructions?: string;
  /** Escalation rung (spec §11): 0 = smallest budget. Raised only after a
   *  verification pass has failed at the current size. */
  tier?: number;
  /** Answer in prose instead of the IR envelope. `/ask` has nothing to parse,
   *  store or apply, so the contract that makes a result machine-readable only
   *  makes the answer unreadable. */
  prose?: boolean;
  /** What has happened in the session this prompt belongs to. The ask path
   *  compiles against an ephemeral session, so without this the model sees the
   *  repository but not the work in progress. */
  sessionState?: string;
}

export async function compileContext(
  session: Session,
  task: Task,
  opts: CompileOptions,
): Promise<CompiledPrompt> {
  const api = staticAnalysis(session.repository.path);
  const { profileName, allocations, budget } = resolveBudget(
    task.type,
    opts.maxContextTokens,
    opts.tier ?? 0,
    Learning.componentWeights(session.repository.path, task.type),
  );
  const kws = session.objective_parsed?.keywords ?? [];
  const taskKws = `${task.title} ${task.description}`.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g)?.slice(0, 8) ?? [];
  const allKws = [...new Set([...kws, ...taskKws])];

  // Select files first so prior reasoning/failures can also be retrieved by code
  // locus (spec §8.4/§8.5) — memory that compounds on the files being touched,
  // not just on prose keyword overlap.
  const fileCosts: Array<{ path: string; tokens: number; reasons?: string[] }> = [];
  const fileBudget = allocations[C.RELEVANT_FILES] ?? Math.floor(opts.maxContextTokens * 0.3);
  const files = await selectFiles(api, task, fileBudget, opts.fileCompressionThreshold);
  const selectedPaths = files.map((f) => f.path);

  const components: CompiledComponent[] = [];
  const omitted: ContextComponent[] = [];

  const add = (
    component: ContextComponent,
    heading: string,
    content: string,
    budgetKey = component as string,
  ) => {
    if (!content || !content.trim()) {
      omitted.push(component);
      return;
    }
    const budget = allocations[budgetKey] ?? Infinity;
    let body = content;
    let toks = estimateTokens(body);
    if (toks > budget && budget !== Infinity) {
      body = truncateToTokens(body, budget);
      toks = estimateTokens(body);
    }
    components.push({ component, heading, content: body, estimated_tokens: toks });
  };

  // OBJECTIVE
  add(C.OBJECTIVE, 'Objective', session.objective);

  // CURRENT TASK
  add(
    C.CURRENT_TASK,
    'Current Task',
    yaml.dump({ id: task.id, title: task.title, type: task.type, description: task.description }),
  );

  // EXECUTION PLAN
  if (session.plan && (task.type === 'plan' || profileName === 'planning')) {
    const planYaml = yaml.dump({
      tasks: session.plan.tasks.map((t) => ({ title: t.title, type: t.type, status: t.status })),
    });
    add(C.EXECUTION_PLAN, 'Execution Plan', planYaml);
  }

  // SESSION SO FAR — supplied by callers that compile against an ephemeral
  // session (the ask path) and would otherwise carry no record of the run.
  add(C.SESSION_STATE, 'Session So Far', opts.sessionState ?? '');

  // PROVIDER HANDOFF (spec §13.6) — injected once for the task after a switch.
  const handoff = (session.metadata as Record<string, unknown> | undefined)?.pending_handoff;
  if (typeof handoff === 'string' && handoff.trim()) {
    add(C.PROVIDER_HANDOFF, 'Provider Handoff (state carried from previous provider)', handoff);
  }

  // WIKI SECTIONS
  const wikiSections = readRelevantSections(task.type, allKws, 8);
  if (wikiSections.length) {
    add(
      C.WIKI_SECTIONS,
      'Project Knowledge (from wiki)',
      wikiSections.map((s) => `### ${s.title}\n${s.content}`).join('\n\n'),
    );
  }

  // ARCHITECTURE — the wiki's overview plus the decisions past sessions promoted
  // to long-term memory. Those are the rows the system itself rates highest:
  // importance >= 0.7 and permanent, one session's reasoning each. Nothing read
  // them into a prompt before this, so every session re-derived what an earlier
  // one had already decided and paid for.
  const promoted = LongTerm.byNamespace('architecture')
    .slice(0, 6)
    .map((m) => `- ${m.key}: ${(m.value_markdown ?? '').split('\n')[0]}`)
    .join('\n');
  add(
    C.ARCHITECTURE,
    'Architecture Context',
    [session.architecture?.summary || readArchitecture(), promoted && `Decisions carried forward:\n${promoted}`]
      .filter(Boolean)
      .join('\n\n'),
  );

  // REPOSITORY MAP
  add(C.REPOSITORY_MAP, 'Repository Map', api.renderRepositoryMap(12));

  // PRIOR REASONING (replay) — keyword-relevant merged with file-locus-relevant.
  const reasoning = mergeById(Reasoning.relevant(allKws, 12), Reasoning.byAffectedFiles(selectedPaths, 8));
  if (reasoning.length) {
    // The top three carry their detail. The summary alone is a label — the
    // substance is in `detail`, which MemoryCompressorWorker pays an LLM call to
    // compress and which, until now, no prompt read. Either include it or stop
    // buying it; including it is the cheaper of the two.
    const txt = reasoning
      .map((r, i) => {
        Reasoning.incrementReference(r.id);
        const head = `- [${r.type}] ${r.summary} (confidence ${r.confidence.toFixed(2)})`;
        const detail = i < 3 && r.detail && r.detail !== r.summary ? `\n  ${r.detail.slice(0, 400)}` : '';
        return head + detail;
      })
      .join('\n');
    add(C.PRIOR_REASONING, 'Prior Reasoning (relevant to this task)', txt);
  } else {
    omitted.push(C.PRIOR_REASONING);
  }

  // KNOWN FAILURES — keyword-relevant merged with failures recorded on these files.
  const failures = mergeById(Failures.relevant(allKws, 6), Failures.byAffectedFiles(selectedPaths, 6));
  if (failures.length) {
    add(
      C.KNOWN_FAILURES,
      'Known Failures (do not repeat these approaches)',
      failures.map((f) => `- Tried: ${f.approach_attempted}\n  Failed because: ${f.why_it_failed}`).join('\n'),
    );
  } else {
    omitted.push(C.KNOWN_FAILURES);
  }

  // CONVENTIONS
  const conventions = readConventions(6);
  if (conventions.length) {
    add(C.CONVENTIONS, 'Conventions', conventions.map((c) => `### ${c.title}\n${c.content}`).join('\n\n'));
  } else {
    omitted.push(C.CONVENTIONS);
  }

  // CONSTRAINTS
  if (session.constraints.length) {
    add(C.CONSTRAINTS, 'Constraints', session.constraints.map((c) => `- ${c.description}`).join('\n'));
  } else {
    omitted.push(C.CONSTRAINTS);
  }

  // OPEN QUESTIONS
  const open = session.open_questions.filter((q) => q.status === 'open');
  if (open.length) {
    add(C.OPEN_QUESTIONS, 'Open Questions', open.map((q) => `- ${q.text}`).join('\n'));
  } else {
    omitted.push(C.OPEN_QUESTIONS);
  }

  // RECENT CHANGES
  if (['debugging', 'review', 'implementation'].includes(profileName)) {
    const diff = await api.getWorkingDiff();
    if (diff.trim()) {
      add(C.RECENT_CHANGES, 'Recent Changes', '```diff\n' + diff.slice(0, 8000) + '\n```');
    } else {
      omitted.push(C.RECENT_CHANGES);
    }
  }

  // RELEVANT FILES (largest budget) — selected earlier so memory could key on them.
  if (files.length) {
    // Annotate each file with its RKG role + immediate dependencies (spec §6.4) so
    // the model gets "what this file is for and how it connects", not just contents.
    const subgraph = api.rkg().relevantSubgraph(selectedPaths);
    const annotate = (p: string): string => {
      const g = subgraph.get(p);
      if (!g) return '';
      const role = g.purpose || g.role;
      const imps = g.imports.slice(0, 4).join(', ');
      return [role ? `role: ${role}` : '', imps ? `imports: ${imps}` : ''].filter(Boolean).join('; ');
    };
    const txt = files
      .map((f) => {
        const ann = annotate(f.path);
        return `### ${f.path}${f.compressed ? ' (compressed)' : ''}${ann ? ` — ${ann}` : ''}\n\`\`\`\n${f.content}\n\`\`\``;
      })
      .join('\n\n');
    for (const f of files) fileCosts.push({ path: f.path, tokens: estimateTokens(f.content), reasons: f.reasons });
    components.push({
      component: C.RELEVANT_FILES,
      heading: 'Files for This Task',
      content: txt,
      estimated_tokens: estimateTokens(txt),
    });
  } else {
    omitted.push(C.RELEVANT_FILES);
  }

  // INSTRUCTIONS
  const instructions =
    opts.taskInstructions ?? defaultInstructions(task.type);
  components.push({
    component: C.INSTRUCTIONS,
    heading: 'Instructions',
    content: instructions,
    estimated_tokens: estimateTokens(instructions),
  });

  // Assemble
  const ordered = orderComponents(components);

  // Graded budget enforcement (spec §11.4): compress low-priority components,
  // then drop them, until the context fits the model window (reserving output room).
  const format = opts.prose ? PROSE_OUTPUT_FORMAT : OUTPUT_FORMAT;
  const system = opts.prose ? PROSE_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const overhead = estimateTokens(format) + estimateTokens(system);
  const ceiling = Math.max(1, budget - 8192 - overhead);
  const { compressed, dropped } = enforceBudget(ordered, ceiling);
  for (const d of dropped) omitted.push(d);

  const totalTokens = ordered.reduce((a, c) => a + c.estimated_tokens, 0) + estimateTokens(format);

  const budgetComment = `<!-- Profile: ${profileName}
     Compiled: ${now()}
     Tokens (est): ${totalTokens} / ${opts.maxContextTokens}
     Components: ${ordered.map((c) => c.component).join(', ')}
     Compressed: ${compressed.length ? compressed.join(', ') : 'none'}
     Omitted: ${omitted.length ? omitted.join(', ') : 'none'} -->`;

  // The manifest goes last: it carries a timestamp, and as the first line it
  // broke prefix caching for every prompt the tool had ever sent.
  const body = [
    '# CodeMaster Context',
    ...ordered.map((c) => `## ${c.heading}\n${c.content}`),
    format,
    budgetComment,
  ].join('\n\n');

  return {
    session_id: session.id,
    task_id: task.id,
    task_type: task.type,
    compiled_at: now(),
    system,
    free_form: opts.prose ?? false,
    components: ordered,
    body,
    total_tokens: totalTokens,
    max_tokens: opts.maxContextTokens,
    included: ordered.map((c) => c.component),
    file_costs: fileCosts,
    omitted,
  };
}

// Ordered most-stable first. Everything above CURRENT_TASK is identical across
// the iterations of a task, so the vendor's prompt cache can match a long shared
// prefix; the parts that change every iteration are pushed to the tail.
const ORDER: ContextComponent[] = [
  C.CONVENTIONS, C.ARCHITECTURE, C.REPOSITORY_MAP, C.WIKI_SECTIONS, C.CONSTRAINTS,
  C.OBJECTIVE, C.EXECUTION_PLAN, C.SESSION_STATE, C.PRIOR_REASONING, C.KNOWN_FAILURES,
  C.PROVIDER_HANDOFF, C.OPEN_QUESTIONS, C.RELEVANT_FILES, C.CURRENT_TASK,
  C.RECENT_CHANGES, C.INSTRUCTIONS,
];

function orderComponents(components: CompiledComponent[]): CompiledComponent[] {
  return [...components].sort((a, b) => ORDER.indexOf(a.component) - ORDER.indexOf(b.component));
}

// Merge two retrieval result sets, keeping first-seen order and dropping id dups.
function mergeById<T extends { id: string }>(...lists: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        out.push(item);
      }
    }
  }
  return out;
}

function truncateToTokens(text: string, budgetTokens: number): string {
  const maxChars = budgetTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n… (truncated to fit budget)';
}

// Shed order for the budget cascade (spec §11.4): what costs nothing to get
// back, first. The repository map, the recent changes and the file contents are
// re-derived from disk and git on the next compile for zero LLM tokens. A known
// failure cost a whole solver iteration to learn and prior reasoning cost the
// call that produced it — drop those and the next call re-buys them at full
// price, the one thing this system exists not to do. This order used to be
// exactly inverted: failures went second, files were never touched at all.
const REDUCE_ORDER: ContextComponent[] = [
  C.OPEN_QUESTIONS, C.REPOSITORY_MAP, C.RECENT_CHANGES, C.RELEVANT_FILES,
  C.PROVIDER_HANDOFF, C.EXECUTION_PLAN, C.CONSTRAINTS, C.WIKI_SECTIONS,
  C.ARCHITECTURE, C.CONVENTIONS, C.PRIOR_REASONING, C.SESSION_STATE, C.KNOWN_FAILURES,
];
// Never dropped outright — the task cannot be done without these. RELEVANT_FILES
// stays here because a patch needs something to patch, but it is now first in
// line to be COMPRESSED, down to the two best-scoring files.
const KEEP = new Set<ContextComponent>([C.OBJECTIVE, C.CURRENT_TASK, C.INSTRUCTIONS, C.RELEVANT_FILES]);

/** Reduce a single component's content type-appropriately (signatures/sentences/bullets). */
function compressContent(component: ContextComponent, content: string): string {
  switch (component) {
    case C.RELEVANT_FILES: {
      // Whole leading files, not a truncated tail of every file. fileSelector
      // already ranked them, so the first two are the ones the task named; half
      // a file that stops mid-function is worse than not sending it.
      const blocks = content.split(/\n\n(?=### )/);
      return blocks.length > 2 ? blocks.slice(0, 2).join('\n\n') : content;
    }
    case C.PRIOR_REASONING:
    case C.KNOWN_FAILURES:
      // Keep at most the first 2-3 lines of each bullet/entry.
      return content
        .split('\n')
        .filter((l) => l.trim().startsWith('-') || l.trim().startsWith('•'))
        .slice(0, 6)
        .join('\n');
    case C.WIKI_SECTIONS:
    case C.ARCHITECTURE:
      // Keep section headings + first sentence of each.
      return content
        .split(/\n(?=#{1,3}\s)/)
        .map((sec) => {
          const lines = sec.split('\n');
          const head = lines[0] ?? '';
          const firstSentence = (lines.slice(1).join(' ').match(/[^.]*\./)?.[0] ?? lines[1] ?? '').trim();
          return firstSentence ? `${head}\n${firstSentence}` : head;
        })
        .join('\n');
    case C.RELEVANT_FILES:
      // Keep declaration/signature-bearing lines only.
      return content
        .split('\n')
        .filter((l) => /^###\s|```|\b(function|class|interface|type|def|func|fn|struct|export|import|const|public|private)\b/.test(l))
        .join('\n');
    default:
      return truncateToTokens(content, Math.floor(estimateTokens(content) / 2));
  }
}

/** Compress then drop low-priority components until under the ceiling (spec §11.4). */
export function enforceBudget(
  components: CompiledComponent[],
  ceiling: number,
): { compressed: ContextComponent[]; dropped: ContextComponent[] } {
  const compressed: ContextComponent[] = [];
  const dropped: ContextComponent[] = [];
  const total = () => components.reduce((a, c) => a + c.estimated_tokens, 0);

  // Stage 1: compress low-priority components in increasing importance.
  for (const comp of REDUCE_ORDER) {
    if (total() <= ceiling) break;
    const c = components.find((x) => x.component === comp);
    if (!c) continue;
    const reduced = compressContent(comp, c.content);
    if (reduced && reduced.length < c.content.length) {
      c.content = reduced;
      c.estimated_tokens = estimateTokens(reduced);
      compressed.push(comp);
    }
  }

  // Stage 2: drop lowest-priority components (never the KEEP set).
  for (const comp of REDUCE_ORDER) {
    if (total() <= ceiling) break;
    if (KEEP.has(comp)) continue;
    const idx = components.findIndex((x) => x.component === comp);
    if (idx >= 0) {
      components.splice(idx, 1);
      dropped.push(comp);
    }
  }
  return { compressed, dropped };
}

function defaultInstructions(taskType: string): string {
  const map: Record<string, string> = {
    plan: 'Produce an execution plan as next_tasks. Each task should be a concrete, verifiable unit of work. Record planning decisions.',
    implement: 'Implement the task by producing unified-diff patches against the provided files. Follow conventions exactly. Record key decisions.',
    debug: 'Diagnose the root cause first, then produce a patch. Record the diagnosis as an observation and the fix rationale as a decision.',
    refactor: 'Refactor without changing behavior. Keep diffs tight and local. Record any structural decisions.',
    test: 'Write or fix tests. Cover edge cases. Follow the existing testing conventions.',
    review: 'Review the changes for correctness, convention adherence, and risks. Report findings as observations and risks.',
    verify: 'Verify the change does what the task requires. Report pass/fail with evidence.',
  };
  return map[taskType] ?? map.implement!;
}
