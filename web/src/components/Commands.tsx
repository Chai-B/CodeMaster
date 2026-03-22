"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

type Command = {
  cmd: string;
  desc: string;
  output: { text: string; color: string }[];
};

const COMMANDS: Command[] = [
  {
    cmd: "/fix",
    desc: "Fix bugs with surgical precision",
    output: [
      { text: "⏺  Analyzing error context...", color: "#7DA0C7" },
      { text: "⏺  Search → src/utils/parser.ts:142", color: "#7DA0C7" },
      { text: "✓  Root cause: null check missing before .trim()", color: "#4ADE80" },
      { text: "⏺  Applying targeted fix...", color: "#7DA0C7" },
      { text: "✓  parser.ts patched — 1 line changed", color: "#4ADE80" },
      { text: "⏺  Validator → running jest...", color: "#7DA0C7" },
      { text: "✓  All 34 tests passing", color: "#4ADE80" },
    ],
  },
  {
    cmd: "/refactor",
    desc: "Refactor with AI planning",
    output: [
      { text: "⏺  REFACTOR task detected", color: "#7DA0C7" },
      { text: "⏺  Deps → scanning import graph...", color: "#7DA0C7" },
      { text: "  Found 7 affected modules", color: "#6B7280" },
      { text: "⏺  Planner → generating plan...", color: "#7DA0C7" },
      { text: "  Step 1: extract shared interface", color: "#6B7280" },
      { text: "  Step 2: update implementations", color: "#6B7280" },
      { text: "  Step 3: clean up dead code", color: "#6B7280" },
      { text: "✓  Refactor complete — 7 files updated", color: "#4ADE80" },
    ],
  },
  {
    cmd: "/feature",
    desc: "Build features step by step",
    output: [
      { text: "⏺  FEATURE task detected", color: "#7DA0C7" },
      { text: "⏺  Planner → scoping feature...", color: "#7DA0C7" },
      { text: "  Step 1: create service module", color: "#6B7280" },
      { text: "  Step 2: add API route handler", color: "#6B7280" },
      { text: "  Step 3: wire up frontend hook", color: "#6B7280" },
      { text: "  Step 4: add tests", color: "#6B7280" },
      { text: "⏺  Executing 4 steps...", color: "#7DA0C7" },
      { text: "✓  Feature shipped — 5 new files", color: "#4ADE80" },
    ],
  },
  {
    cmd: "/generate",
    desc: "Generate new code or files",
    output: [
      { text: "⏺  GENERATE task detected", color: "#7DA0C7" },
      { text: "⏺  Context → reading project structure", color: "#7DA0C7" },
      { text: "⏺  Coder → generating...", color: "#7DA0C7" },
      { text: "✓  components/DataTable.tsx created", color: "#4ADE80" },
      { text: "✓  Follows project conventions", color: "#4ADE80" },
      { text: "✓  TypeScript types included", color: "#4ADE80" },
    ],
  },
  {
    cmd: "/test",
    desc: "Write and fix tests",
    output: [
      { text: "⏺  TEST task detected", color: "#7DA0C7" },
      { text: "⏺  Search → reading auth.service.ts", color: "#7DA0C7" },
      { text: "⏺  Coder → generating test suite...", color: "#7DA0C7" },
      { text: "✓  auth.service.test.ts created", color: "#4ADE80" },
      { text: "  14 test cases across 4 describe blocks", color: "#6B7280" },
      { text: "⏺  Running tests...", color: "#7DA0C7" },
      { text: "✓  14/14 passing", color: "#4ADE80" },
    ],
  },
  {
    cmd: "/docs",
    desc: "Generate documentation",
    output: [
      { text: "⏺  DOCS task detected", color: "#7DA0C7" },
      { text: "⏺  Search → scanning public API surface", color: "#7DA0C7" },
      { text: "  Found 23 exported functions", color: "#6B7280" },
      { text: "⏺  Coder → adding JSDoc comments...", color: "#7DA0C7" },
      { text: "✓  23 functions documented", color: "#4ADE80" },
      { text: "✓  README.md updated with API reference", color: "#4ADE80" },
    ],
  },
  {
    cmd: "/explain",
    desc: "Understand complex code",
    output: [
      { text: "⏺  EXPLAIN task detected", color: "#7DA0C7" },
      { text: "⏺  Reading middleware/ratelimiter.ts...", color: "#7DA0C7" },
      { text: "  Uses sliding window algorithm", color: "#6B7280" },
      { text: "  Stores counters in Redis with TTL", color: "#6B7280" },
      { text: "  Falls back to in-memory if Redis down", color: "#6B7280" },
      { text: "  Headers: X-RateLimit-Remaining", color: "#6B7280" },
      { text: "✓  Explanation complete", color: "#4ADE80" },
    ],
  },
  {
    cmd: "/run",
    desc: "Execute shell commands",
    output: [
      { text: "⏺  RUN: npm run build", color: "#7DA0C7" },
      { text: "", color: "#6B7280" },
      { text: "  > web@0.1.0 build", color: "#6B7280" },
      { text: "  > next build", color: "#6B7280" },
      { text: "", color: "#6B7280" },
      { text: "   ▲ Next.js 16.2.0", color: "#6B7280" },
      { text: "   ✓ Compiled successfully", color: "#4ADE80" },
    ],
  },
  {
    cmd: "/git",
    desc: "Git operations in-TUI",
    output: [
      { text: "⏺  GIT: git status", color: "#7DA0C7" },
      { text: "  On branch main", color: "#6B7280" },
      { text: "  Changes to be committed:", color: "#6B7280" },
      { text: "    modified: src/api/routes.ts", color: "#4ADE80" },
      { text: "    new file: src/lib/cache.ts", color: "#4ADE80" },
      { text: "✓  Ready to commit", color: "#4ADE80" },
    ],
  },
  {
    cmd: "/diff",
    desc: "View current git diff",
    output: [
      { text: "⏺  GIT DIFF: src/api/routes.ts", color: "#7DA0C7" },
      { text: "  @@ -47,6 +47,12 @@", color: "#6B7280" },
      { text: "+ const cached = await cache.get(key);", color: "#4ADE80" },
      { text: "+ if (cached) return res.json(cached);", color: "#4ADE80" },
      { text: "  const data = await db.query(sql);", color: "#6B7280" },
      { text: "+ await cache.set(key, data, 300);", color: "#4ADE80" },
      { text: "  return res.json(data);", color: "#6B7280" },
    ],
  },
  {
    cmd: "/scan",
    desc: "Index project for search",
    output: [
      { text: "⏺  Scanning project...", color: "#7DA0C7" },
      { text: "  Indexing src/ — 143 files", color: "#6B7280" },
      { text: "  Indexing tests/ — 67 files", color: "#6B7280" },
      { text: "  Building symbol index...", color: "#6B7280" },
      { text: "✓  1,247 symbols indexed", color: "#4ADE80" },
      { text: "✓  Search ready — 0.3ms avg lookup", color: "#4ADE80" },
    ],
  },
  {
    cmd: "/cc",
    desc: "Open full Claude Code",
    output: [
      { text: "⏺  Launching Claude Code...", color: "#7DA0C7" },
      { text: "  Passing project context", color: "#6B7280" },
      { text: "  cwd: ~/myproject", color: "#6B7280" },
      { text: "✓  Claude Code ready", color: "#4ADE80" },
      { text: "  Full MCP tools available", color: "#6B7280" },
      { text: "  Type anything to start", color: "#6B7280" },
    ],
  },
];

export default function Commands() {
  const [selected, setSelected] = useState(0);

  return (
    <section id="commands" className="py-32 relative">
      <div className="max-w-6xl mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-16"
        >
          <p className="text-sm font-mono text-[#7DA0C7] mb-3 tracking-widest uppercase">
            Commands
          </p>
          <h2 className="text-4xl font-bold tracking-tight mb-4">
            Every command you need
          </h2>
          <p className="text-[#6B7280] max-w-md mx-auto">
            One tool for the full dev workflow. Click any command to see what
            it does.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="grid lg:grid-cols-2 gap-6"
        >
          {/* Left: command list */}
          <div className="bg-[#111111] border border-[rgba(255,255,255,0.06)] rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[rgba(255,255,255,0.06)]">
              <span className="text-xs font-mono text-[#6B7280]">
                available commands
              </span>
            </div>
            <div className="p-2">
              {COMMANDS.map((cmd, i) => (
                <button
                  key={cmd.cmd}
                  onClick={() => setSelected(i)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 text-left group ${
                    selected === i
                      ? "bg-[rgba(125,160,199,0.1)] border border-[rgba(125,160,199,0.2)]"
                      : "hover:bg-[rgba(255,255,255,0.04)] border border-transparent"
                  }`}
                >
                  <span
                    className={`font-mono text-sm font-semibold w-20 flex-shrink-0 ${
                      selected === i ? "text-[#7DA0C7]" : "text-[#F5F5F5]"
                    }`}
                  >
                    {cmd.cmd}
                  </span>
                  <span className="text-xs text-[#6B7280] group-hover:text-[#9CA3AF] transition-colors">
                    {cmd.desc}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Right: output preview */}
          <div className="bg-[#0D1117] border border-[rgba(255,255,255,0.06)] rounded-xl overflow-hidden terminal-glow">
            <div className="flex items-center gap-2 px-4 py-3 bg-[#111111] border-b border-[rgba(255,255,255,0.06)]">
              <span className="w-2.5 h-2.5 rounded-full bg-[#FF5F57]" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#FEBC2E]" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#28C840]" />
              <span className="ml-2 text-xs font-mono text-[#6B7280]">
                codemaster output
              </span>
            </div>

            <div className="p-5 font-mono text-sm min-h-[280px]">
              {/* Prompt */}
              <div className="flex items-center gap-2 mb-4">
                <span className="text-[#4ADE80]">❯</span>
                <span className="text-[#F5F5F5]">codemaster</span>
                <span className="text-[#7DA0C7]">
                  {COMMANDS[selected].cmd} ...
                </span>
              </div>

              {/* Animated output */}
              <AnimatePresence mode="wait">
                <motion.div
                  key={selected}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.2 }}
                  className="space-y-1.5 pl-2"
                >
                  {COMMANDS[selected].output.map((line, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.15, delay: i * 0.06 }}
                      style={{ color: line.color }}
                      className="text-xs leading-relaxed"
                    >
                      {line.text || "\u00A0"}
                    </motion.div>
                  ))}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
