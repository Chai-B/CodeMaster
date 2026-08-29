// Output format specification injected into every prompt (spec §10.5).

/** Separates a diff-format response from its reasoning block. Deliberately not
 *  a bare `---`: that is a legal context line inside a diff of any file with
 *  YAML front matter, and splitting on it would truncate the patch. */
export const REASONING_MARKER = '<<<REASONING>>>';

export const OUTPUT_FORMAT = `## Output Format

Respond using the following structure only. No prose outside of these tags.

CODE OUTPUT RULES (important):
- For EVERY file you create OR modify, output its COMPLETE final content inside a
  <file path="..."> tag — never a unified diff, never a fragment. Full files apply
  deterministically; diffs do not.
- A correct fix OFTEN SPANS MULTIPLE FILES. The relevant files are provided in the
  context above. Trace the change through: where the value/type is defined, where it
  is validated or transformed, and where it is documented or serialized — and output
  the complete content of EVERY file that must change, not just the most obvious one.
- You MUST output code whenever the task asks for an implementation. Returning an
  empty <files/> with a "no changes needed" summary is only valid if the task is
  genuinely already satisfied — and even then, output the existing file's current
  content in a <file> tag so the result is verifiable.
- Preserve the surrounding file when modifying: reproduce the whole file with your
  change integrated, matching the repo's existing style and imports.

<task_result>
  <status>completed|partial|failed|blocked|needs_clarification</status>
  <summary>One sentence summary of what was done</summary>
  <files>
    <file path="relative/path/to/file">COMPLETE final file content here</file>
  </files>
  <reasoning>
    <decision question="..." answer="..." confidence="0.0-1.0" reversibility="easy|medium|hard|irreversible">
      <evidence>...</evidence>
      <alternative option="..." rejected_because="..."/>
      <implication>...</implication>
    </decision>
    <risk likelihood="low|medium|high" impact="low|medium|high|critical">
      <description>...</description>
      <mitigation>...</mitigation>
    </risk>
    <observation confidence="0.0-1.0">...</observation>
    <assumption confidence="0.0-1.0">...</assumption>
  </reasoning>
  <wiki_updates>
    <update key="namespace/key">New content for this wiki entry</update>
  </wiki_updates>
  <open_questions>
    <question>...</question>
  </open_questions>
  <next_tasks>
    <!-- depends_on: titles of sibling tasks, comma-separated. Omit it when the
         task is independent — independent tasks are what let the plan branch
         instead of running as one forced chain. -->
    <task priority="high|medium|low" type="implement|test|review|refactor|debug" depends_on="">...</task>
  </next_tasks>
</task_result>`;

// Answering a question is not producing a work product: there is no file to
// apply, no decision to persist, no next task to schedule. The IR envelope
// exists so a result can be parsed and stored, and a question has nothing to
// store — so `/ask` swaps the contract rather than making the reader unwrap XML.
export const PROSE_OUTPUT_FORMAT = `## Output Format

Answer in plain markdown prose. No XML, no JSON, no <task_result> block.

Be direct: lead with the answer, then the detail that supports it. Cite the code
you relied on as \`path:line\` so the reader can check you. Keep it as short as
the question allows.`;

export const PROSE_SYSTEM_PROMPT = `You are the question-answering engine of CodeMaster, a persistent reasoning layer for software engineering.

You receive a deterministically compiled context: the objective, prior reasoning, repository knowledge, and the exact files relevant to the question. This context is assembled from structured state, not conversation history. Trust it as the complete and authoritative picture.

Rules:
- Answer the question. Do not propose edits, emit patches, or plan work.
- Ground every claim in the context you were given, and cite it as \`path:line\`.
- If the context does not contain what the question needs, say exactly what is missing. A confident wrong answer about someone's own code is worse than none.
- Plain markdown prose. No output tags of any kind.`;

// Native JSON output spec (spec §15.1) — providers that emit structured JSON
// (OpenAI, Gemini) override the XML format with this. Parsed by irFromJson.
export const JSON_OUTPUT_FORMAT = `## Output Format (OVERRIDE)

Ignore any XML format above. Respond with ONLY a single JSON object, no prose, matching.
For every file you create OR modify, put its COMPLETE final content in files_created
(never a diff). Always output the actual code the task asks for.

{
  "status": "completed|partial|failed|blocked|needs_clarification",
  "summary": "one sentence",
  "files_created": [{ "path": "relative/path", "content": "COMPLETE final file content" }],
  "decisions": [{ "question": "", "answer": "", "detail": "", "confidence": 0.9, "reversibility": "easy|medium|hard|irreversible", "alternatives": [{ "option": "", "rejected_because": "" }] }],
  "observations": [{ "summary": "", "detail": "", "confidence": 0.8 }],
  "risks": [{ "description": "", "likelihood": "low|medium|high", "impact": "low|medium|high|critical", "mitigation": "" }],
  "assumptions": [{ "summary": "", "detail": "", "confidence": 0.6 }],
  "wiki_updates": [{ "key": "namespace/key", "content": "markdown" }],
  "next_tasks": [{ "title": "", "type": "implement|test|review|refactor|debug", "priority": "high|medium|low", "depends_on": [] }],
  "open_questions": ["..."],
  "blocked_by": ["..."],
  "confidence": 0.85
}`;

// Native diff output spec (spec §15.1) — Codex returns raw unified diffs.
//
// The diffs alone gave this provider no way to contribute to the reasoning
// layer: every decision it made died with the response, so a session that
// switched to Codex stopped accumulating the thing the tool exists to keep.
// The trailing block is optional to parse and cheap to emit — a few hundred
// tokens buys the same persistence the XML and JSON formats already have.
export const DIFF_OUTPUT_FORMAT = `## Output Format (OVERRIDE)

Respond with unified diff patches (git diff format), no prose. For each changed file:

diff --git a/relative/path b/relative/path
--- a/relative/path
+++ b/relative/path
@@ ... @@
 context
-removed
+added

After the last diff, and only there, emit this marker on its own line followed by
a single JSON object recording what you decided. It is persisted and replayed to
future sessions, so record the reasoning a later reader could not re-derive from
the diff itself. Omit any key you have nothing for.

${REASONING_MARKER}
{
  "summary": "one sentence",
  "decisions": [{ "question": "", "answer": "", "detail": "", "confidence": 0.9, "reversibility": "easy|medium|hard|irreversible" }],
  "risks": [{ "description": "", "likelihood": "low|medium|high", "impact": "low|medium|high|critical", "mitigation": "" }],
  "observations": [{ "summary": "", "detail": "", "confidence": 0.8 }],
  "assumptions": [{ "summary": "", "confidence": 0.6 }]
}`;

export const SYSTEM_PROMPT = `You are the execution engine of CodeMaster, a persistent reasoning layer for software engineering.

You receive a deterministically compiled context: objective, plan, prior reasoning, repository knowledge, and the exact files relevant to the current task. This context is assembled from structured state — not conversation history. Trust it as the complete and authoritative picture.

Rules:
- Output the COMPLETE final content of every file you create or modify (in a <file> tag) — never a diff or a fragment. Always produce the actual code the task asks for.
- Record every significant decision, risk, and assumption as structured reasoning — it is persisted and reused, so future sessions never re-derive it.
- Honor all stated constraints and conventions exactly; match the repository's existing style.
- Do not restate the context back. Do not add prose outside the required output tags.
- If you lack information to proceed safely, return status needs_clarification with a specific question.`;
