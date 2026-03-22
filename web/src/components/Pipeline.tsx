"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

type Stage = {
  id: string;
  name: string;
  desc: string;
  detail: string;
  isLLM: boolean;
  tools?: string[];
};

const STAGES: Stage[] = [
  {
    id: "router",
    name: "Router",
    desc: "Classifies intent",
    detail:
      "Parses your command and determines the task type: FIX, REFACTOR, FEATURE, GENERATE, TEST, DOCS, or EXPLAIN. No LLM needed — this is pure string matching and heuristics.",
    isLLM: false,
    tools: ["regex", "heuristics"],
  },
  {
    id: "search",
    name: "Search",
    desc: "Finds relevant files",
    detail:
      "Uses the repo map plus grep and glob to locate files relevant to your task. Returns a compact list of file paths and symbols — never full file contents. Typically 5–10 files.",
    isLLM: false,
    tools: ["grep", "glob", "repo_map.json"],
  },
  {
    id: "deps",
    name: "Deps",
    desc: "Maps dependencies",
    detail:
      "Traces imports and references across the files found by Search. Surfaces related modules that will be affected by the planned change, without expanding the whole dependency graph.",
    isLLM: false,
    tools: ["ast", "import tracing"],
  },
  {
    id: "planner",
    name: "Planner",
    desc: "Breaks down the task",
    detail:
      "LLM stage — only runs for FEATURE and REFACTOR tasks. Produces a numbered, step-by-step execution plan tailored to the task complexity. Simple tasks get 1–2 steps; large features get 6–10+.",
    isLLM: true,
    tools: ["claude -p", "--tools \"\""],
  },
  {
    id: "coder",
    name: "Coder",
    desc: "Writes and edits code",
    detail:
      "LLM stage with full tool access. Claude reads, writes, and edits files directly using its native tools — no diff generation or patching. For large tasks it runs in multiple passes until complete (NEEDS_CONTINUATION protocol).",
    isLLM: true,
    tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
  },
  {
    id: "changes",
    name: "Changes",
    desc: "Diffs what changed",
    detail:
      "Runs git diff HEAD to capture exactly what the Coder modified. Surfaces a structured list of changed files and a full unified diff passed to the next stages.",
    isLLM: false,
    tools: ["git diff"],
  },
  {
    id: "analysis",
    name: "Analysis",
    desc: "Static checks",
    detail:
      "Runs any linters, type checkers, and test commands configured for the project. Collects stdout/stderr output and exit codes. Errors are passed to the Validator for a fix loop.",
    isLLM: false,
    tools: ["pylint", "tsc", "pytest", "eslint"],
  },
  {
    id: "validator",
    name: "Validator",
    desc: "Verifies correctness",
    detail:
      "Inspects Analysis output. If errors are found, triggers a targeted LLM fix loop — re-running Coder with the errors as context until Analysis passes or max passes are reached.",
    isLLM: false,
    tools: ["error parsing", "fix loop"],
  },
  {
    id: "reviewer",
    name: "Reviewer",
    desc: "Final review",
    detail:
      "LLM stage. Receives the full diff and analysis results. Reviews for correctness, style, and intent alignment. Flags issues or approves the change with a short summary.",
    isLLM: true,
    tools: ["claude -p", "--tools \"\""],
  },
];

const PHASE_LABELS = [
  { label: "Pre-processing", range: [0, 2] },
  { label: "LLM", range: [3, 4] },
  { label: "Verification", range: [5, 8] },
];

export default function Pipeline() {
  const [selectedId, setSelectedId] = useState<string>("coder");

  const selected = STAGES.find((s) => s.id === selectedId)!;

  return (
    <section id="pipeline" className="py-32 relative overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 40%, rgba(60,75,94,0.07) 0%, transparent 70%)",
        }}
      />

      <div className="max-w-5xl mx-auto px-6 relative">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-16"
        >
          <p className="text-xs font-mono text-[#7DA0C7] mb-3 tracking-widest uppercase">
            Architecture
          </p>
          <h2 className="text-4xl font-bold tracking-tight mb-4">
            The Pipeline
          </h2>
          <p className="text-[#6B7280] max-w-lg mx-auto text-sm leading-relaxed">
            Deterministic preprocessing before every LLM call. Minimal tokens,
            maximum precision. Click any stage to inspect it.
          </p>
        </motion.div>

        {/* Flow — desktop */}
        <div className="hidden lg:block mb-4">
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-40px" }}
            className="relative"
          >
            {/* Animated connector line */}
            <motion.div
              initial={{ scaleX: 0 }}
              whileInView={{ scaleX: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8, ease: "easeOut", delay: 0.2 }}
              className="absolute top-[28px] left-[2%] right-[2%] h-px bg-gradient-to-r from-transparent via-[rgba(125,160,199,0.15)] to-transparent origin-left"
            />

            <div className="flex items-start gap-1">
              {STAGES.map((stage, i) => (
                <motion.button
                  key={stage.id}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.35, delay: i * 0.06 }}
                  onClick={() => setSelectedId(stage.id)}
                  className="flex-1 flex flex-col items-center gap-2 group focus:outline-none"
                >
                  {/* Node circle */}
                  <div className="relative">
                    {stage.isLLM && (
                      <motion.div
                        animate={{ opacity: [0.4, 0.8, 0.4] }}
                        transition={{
                          duration: 2.5,
                          repeat: Infinity,
                          ease: "easeInOut",
                        }}
                        className="absolute -inset-2 rounded-full bg-[rgba(125,160,199,0.12)]"
                      />
                    )}
                    <div
                      className={`relative w-14 h-14 rounded-full flex items-center justify-center border-2 transition-all duration-200 ${
                        selectedId === stage.id
                          ? stage.isLLM
                            ? "bg-[rgba(125,160,199,0.18)] border-[rgba(125,160,199,0.6)] shadow-[0_0_20px_rgba(125,160,199,0.2)]"
                            : "bg-[#1a1a1a] border-[rgba(255,255,255,0.3)] shadow-[0_0_12px_rgba(255,255,255,0.06)]"
                          : stage.isLLM
                          ? "bg-[rgba(125,160,199,0.06)] border-[rgba(125,160,199,0.2)] group-hover:bg-[rgba(125,160,199,0.12)] group-hover:border-[rgba(125,160,199,0.35)]"
                          : "bg-[#111111] border-[rgba(255,255,255,0.08)] group-hover:border-[rgba(255,255,255,0.18)]"
                      }`}
                    >
                      <span
                        className={`text-[10px] font-mono font-bold tracking-widest ${
                          selectedId === stage.id
                            ? stage.isLLM
                              ? "text-[#7DA0C7]"
                              : "text-[#F5F5F5]"
                            : "text-[#6B7280] group-hover:text-[#9CA3AF]"
                        }`}
                      >
                        {i + 1}
                      </span>
                    </div>
                  </div>

                  {/* Label */}
                  <div className="text-center">
                    <p
                      className={`text-[10px] font-mono font-semibold tracking-wider transition-colors duration-200 ${
                        selectedId === stage.id
                          ? "text-[#F5F5F5]"
                          : "text-[#6B7280] group-hover:text-[#9CA3AF]"
                      }`}
                    >
                      {stage.name.toUpperCase()}
                    </p>
                    {stage.isLLM && (
                      <span className="text-[8px] font-mono text-[#7DA0C7] opacity-70">
                        LLM
                      </span>
                    )}
                  </div>
                </motion.button>
              ))}
            </div>
          </motion.div>
        </div>

        {/* Detail panel */}
        <AnimatePresence mode="wait">
          <motion.div
            key={selectedId}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            className={`hidden lg:block rounded-xl border p-6 ${
              selected.isLLM
                ? "bg-[rgba(125,160,199,0.04)] border-[rgba(125,160,199,0.15)]"
                : "bg-[#0D1117] border-[rgba(255,255,255,0.06)]"
            }`}
          >
            <div className="flex items-start justify-between gap-6">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-3">
                  <h3 className="text-base font-mono font-bold text-[#F5F5F5] tracking-wide">
                    {selected.name.toUpperCase()}
                  </h3>
                  {selected.isLLM ? (
                    <span className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-[rgba(125,160,199,0.15)] text-[#7DA0C7] border border-[rgba(125,160,199,0.3)]">
                      LLM call
                    </span>
                  ) : (
                    <span className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-[rgba(255,255,255,0.04)] text-[#6B7280] border border-[rgba(255,255,255,0.08)]">
                      Deterministic
                    </span>
                  )}
                </div>
                <p className="text-sm text-[#9CA3AF] leading-relaxed max-w-2xl">
                  {selected.detail}
                </p>
              </div>

              {selected.tools && (
                <div className="flex-shrink-0">
                  <p className="text-[9px] font-mono text-[#4B5563] uppercase tracking-widest mb-2">
                    Uses
                  </p>
                  <div className="flex flex-wrap gap-1.5 max-w-[200px] justify-end">
                    {selected.tools.map((tool) => (
                      <span
                        key={tool}
                        className="text-[9px] font-mono px-2 py-1 rounded bg-[rgba(255,255,255,0.04)] text-[#6B7280] border border-[rgba(255,255,255,0.06)] whitespace-nowrap"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Stage nav dots */}
            <div className="flex items-center gap-1.5 mt-5">
              {STAGES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  className={`transition-all duration-200 rounded-full focus:outline-none ${
                    s.id === selectedId
                      ? s.isLLM
                        ? "w-4 h-1.5 bg-[#7DA0C7]"
                        : "w-4 h-1.5 bg-[#F5F5F5]"
                      : "w-1.5 h-1.5 bg-[#2a2a2a] hover:bg-[#3a3a3a]"
                  }`}
                />
              ))}
            </div>
          </motion.div>
        </AnimatePresence>

        {/* Mobile: vertical list */}
        <div className="lg:hidden space-y-0">
          {STAGES.map((stage, i) => (
            <motion.div
              key={stage.id}
              initial={{ opacity: 0, x: -12 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.35, delay: i * 0.04 }}
            >
              <button
                onClick={() =>
                  setSelectedId(selectedId === stage.id ? "" : stage.id)
                }
                className="w-full flex gap-4 items-start text-left py-4 border-b border-[rgba(255,255,255,0.04)] last:border-0"
              >
                {/* Step number */}
                <div className="flex flex-col items-center flex-shrink-0">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-mono font-bold border transition-all ${
                      stage.isLLM
                        ? "bg-[rgba(125,160,199,0.1)] text-[#7DA0C7] border-[rgba(125,160,199,0.2)]"
                        : "bg-[#111111] text-[#6B7280] border-[rgba(255,255,255,0.08)]"
                    }`}
                  >
                    {i + 1}
                  </div>
                  {i < STAGES.length - 1 && (
                    <div className="w-px h-full min-h-[20px] bg-[rgba(255,255,255,0.04)] mt-1" />
                  )}
                </div>

                <div className="flex-1 pt-0.5">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-mono font-semibold text-[#F5F5F5] tracking-wide">
                      {stage.name}
                    </span>
                    {stage.isLLM && (
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[rgba(125,160,199,0.12)] text-[#7DA0C7] border border-[rgba(125,160,199,0.2)]">
                        LLM
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[#6B7280] leading-relaxed">
                    {selectedId === stage.id ? stage.detail : stage.desc}
                  </p>
                  {selectedId === stage.id && stage.tools && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {stage.tools.map((tool) => (
                        <span
                          key={tool}
                          className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[rgba(255,255,255,0.04)] text-[#4B5563] border border-[rgba(255,255,255,0.06)]"
                        >
                          {tool}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </button>
            </motion.div>
          ))}
        </div>

        {/* Legend */}
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.5 }}
          className="hidden lg:flex justify-center gap-8 mt-10 text-xs text-[#4B5563]"
        >
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-[rgba(125,160,199,0.1)] border border-[rgba(125,160,199,0.2)]" />
            <span>LLM call (claude -p)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-[#111111] border border-[rgba(255,255,255,0.08)]" />
            <span>Deterministic — no LLM</span>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
