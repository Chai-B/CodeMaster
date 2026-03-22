"use client";

import { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const SCENARIOS = [
  {
    command: "/fix divide by zero in calculator.py",
    lines: [
      { text: "⏺  Router → FIX task detected", color: "#7DA0C7", delay: 0 },
      { text: "⏺  Search → scanning src/calculator.py", color: "#7DA0C7", delay: 120 },
      { text: "✓  Found: line 47 — ZeroDivisionError", color: "#4ADE80", delay: 240 },
      { text: "⏺  Planner → single-file surgical fix", color: "#7DA0C7", delay: 380 },
      { text: "⏺  Coder → applying edit...", color: "#7DA0C7", delay: 520 },
      { text: "✓  Edit applied: calculator.py:47", color: "#4ADE80", delay: 660 },
      { text: "⏺  Validator → running pytest", color: "#7DA0C7", delay: 800 },
      { text: "✓  12/12 tests passing", color: "#4ADE80", delay: 940 },
      { text: "✓  Complete — 0 tokens wasted", color: "#4ADE80", delay: 1080 },
    ],
  },
  {
    command: "/refactor auth middleware",
    lines: [
      { text: "⏺  Router → REFACTOR task detected", color: "#7DA0C7", delay: 0 },
      { text: "⏺  Search → indexing middleware/auth.ts", color: "#7DA0C7", delay: 130 },
      { text: "⏺  Deps → mapping 4 dependent modules", color: "#7DA0C7", delay: 260 },
      { text: "⏺  Planner → drafting refactor plan...", color: "#7DA0C7", delay: 400 },
      { text: "  Step 1: extract token validation", color: "#6B7280", delay: 520 },
      { text: "  Step 2: consolidate error handling", color: "#6B7280", delay: 600 },
      { text: "  Step 3: update 4 call sites", color: "#6B7280", delay: 680 },
      { text: "⏺  Coder → executing 3 steps...", color: "#7DA0C7", delay: 820 },
      { text: "✓  Refactor complete — cleaner, typed", color: "#4ADE80", delay: 1100 },
    ],
  },
  {
    command: "/feature add redis caching layer",
    lines: [
      { text: "⏺  Router → FEATURE task detected", color: "#7DA0C7", delay: 0 },
      { text: "⏺  Search → scanning project structure", color: "#7DA0C7", delay: 130 },
      { text: "⏺  Planner → breaking into steps...", color: "#7DA0C7", delay: 280 },
      { text: "  Step 1: add redis client wrapper", color: "#6B7280", delay: 400 },
      { text: "  Step 2: cache DB queries in service layer", color: "#6B7280", delay: 480 },
      { text: "  Step 3: add TTL + invalidation helpers", color: "#6B7280", delay: 560 },
      { text: "⏺  Coder → step 1/3...", color: "#7DA0C7", delay: 700 },
      { text: "✓  lib/redis.ts created", color: "#4ADE80", delay: 860 },
      { text: "⏺  Coder → step 2/3...", color: "#7DA0C7", delay: 960 },
      { text: "✓  Feature complete — 3 files changed", color: "#4ADE80", delay: 1180 },
    ],
  },
];

function TerminalWindow() {
  const [scenarioIdx, setScenarioIdx] = useState(0);
  const [visibleLines, setVisibleLines] = useState(0);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
    setVisibleLines(0);

    const scenario = SCENARIOS[scenarioIdx];

    scenario.lines.forEach((line, i) => {
      const t = setTimeout(() => {
        setVisibleLines((v) => Math.max(v, i + 1));
      }, line.delay + 400);
      timeoutsRef.current.push(t);
    });

    const lastDelay =
      Math.max(...scenario.lines.map((l) => l.delay)) + 2800;
    const cycleTimer = setTimeout(() => {
      setScenarioIdx((prev) => (prev + 1) % SCENARIOS.length);
    }, lastDelay);
    timeoutsRef.current.push(cycleTimer);

    return () => timeoutsRef.current.forEach(clearTimeout);
  }, [scenarioIdx]);

  const scenario = SCENARIOS[scenarioIdx];

  return (
    <div className="terminal-glow rounded-xl overflow-hidden bg-[#0D1117] border border-[rgba(255,255,255,0.08)] w-full max-w-[540px]">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-4 py-3 bg-[#111111] border-b border-[rgba(255,255,255,0.06)]">
        <span className="w-3 h-3 rounded-full bg-[#FF5F57]" />
        <span className="w-3 h-3 rounded-full bg-[#FEBC2E]" />
        <span className="w-3 h-3 rounded-full bg-[#28C840]" />
        <span className="ml-3 text-xs font-mono text-[#6B7280]">
          codemaster — ~/myproject
        </span>
      </div>

      {/* Terminal body */}
      <div className="p-5 font-mono text-sm min-h-[260px]">
        <AnimatePresence mode="wait">
          <motion.div
            key={scenarioIdx}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            {/* Prompt line */}
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[#4ADE80]">❯</span>
              <span className="text-[#F5F5F5]">codemaster</span>
              <span className="text-[#7DA0C7]">{scenario.command}</span>
            </div>

            {/* Output lines */}
            <div className="space-y-1.5 pl-2">
              {scenario.lines.slice(0, visibleLines).map((line, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.2 }}
                  style={{ color: line.color }}
                  className="text-xs leading-relaxed"
                >
                  {line.text}
                </motion.div>
              ))}

              {/* Blinking cursor */}
              {visibleLines < scenario.lines.length && (
                <motion.span
                  animate={{ opacity: [1, 0] }}
                  transition={{ duration: 0.7, repeat: Infinity }}
                  className="inline-block w-1.5 h-4 bg-[#7DA0C7] rounded-sm align-middle"
                />
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Status bar */}
      <div className="px-5 py-2 border-t border-[rgba(255,255,255,0.06)] flex items-center justify-between">
        <span className="text-xs font-mono text-[#6B7280]">
          Claude Code CLI ·{" "}
          <span className="text-[#4ADE80]">connected</span>
        </span>
        <div className="flex gap-1">
          {SCENARIOS.map((_, i) => (
            <span
              key={i}
              className={`w-1.5 h-1.5 rounded-full transition-colors ${
                i === scenarioIdx ? "bg-[#7DA0C7]" : "bg-[#2a2a2a]"
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Hero() {
  return (
    <section className="relative min-h-screen flex items-center overflow-hidden grid-bg pt-16">
      {/* Background gradient */}
      <div className="absolute inset-0 pointer-events-none">
        <motion.div
          animate={{
            scale: [1, 1.08, 1],
            opacity: [0.3, 0.5, 0.3],
          }}
          transition={{ duration: 10, repeat: Infinity, ease: "easeInOut" }}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] rounded-full"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(125,160,199,0.08) 0%, rgba(60,75,94,0.04) 50%, transparent 70%)",
            filter: "blur(40px)",
          }}
        />
      </div>

      <div className="relative max-w-6xl mx-auto px-6 py-24 w-full">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          {/* Left column */}
          <div>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.1 }}
            >
              <Badge className="mb-6">
                <span className="text-[#4ADE80]">●</span>
                Built on Claude Code CLI
              </Badge>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="text-5xl lg:text-6xl font-bold tracking-tight leading-[1.05] mb-6"
            >
              Ship code faster
              <br />
              with AI{" "}
              <span className="gradient-text">you control</span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.3 }}
              className="text-lg text-[#6B7280] leading-relaxed mb-8 max-w-md"
            >
              CodeMaster is a token-efficient coding orchestrator. It runs
              Claude&apos;s full pipeline from your terminal — search, plan,
              edit, validate — without burning through context.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.4 }}
              className="flex flex-wrap gap-3 mb-10"
            >
              <Button size="lg" href="#install">
                Get Started →
              </Button>
              <Button
                size="lg"
                variant="outline"
                href="https://github.com/Chai-B/CodeMaster"
              >
                View on GitHub
              </Button>
            </motion.div>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.6 }}
              className="flex flex-wrap gap-6 text-sm"
            >
              {[
                { stat: "~90% fewer tokens", icon: "⚡" },
                { stat: "Full Claude tool access", icon: "🔧" },
                { stat: "Any repo", icon: "📁" },
              ].map((item) => (
                <div
                  key={item.stat}
                  className="flex items-center gap-1.5 text-[#6B7280]"
                >
                  <span>{item.icon}</span>
                  <span>{item.stat}</span>
                </div>
              ))}
            </motion.div>
          </div>

          {/* Right column — terminal */}
          <motion.div
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6, delay: 0.35 }}
            className="flex justify-center lg:justify-end"
          >
            <TerminalWindow />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
