"use client";

import { useState } from "react";
import { motion } from "framer-motion";

type Step = {
  number: number;
  title: string;
  code: string;
  lang: string;
};

const STEPS: Step[] = [
  {
    number: 1,
    title: "Install globally",
    code: "npm install -g codemaster",
    lang: "bash",
  },
  {
    number: 2,
    title: "Go to any project",
    code: "cd ~/your-project\ncodemaster",
    lang: "bash",
  },
  {
    number: 3,
    title: "Start coding",
    code: "/fix that annoying bug\n/feature add authentication\n/refactor the auth module",
    lang: "text",
  },
];

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = code.split("\n");

  return (
    <div className="relative group bg-[#0D1117] border border-[rgba(255,255,255,0.06)] rounded-lg overflow-hidden">
      {/* Language tag */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[rgba(255,255,255,0.06)]">
        <span className="text-[10px] font-mono text-[#6B7280] uppercase tracking-widest">
          {lang}
        </span>
        <button
          onClick={handleCopy}
          className="text-[10px] font-mono text-[#6B7280] hover:text-[#F5F5F5] transition-colors flex items-center gap-1.5"
        >
          {copied ? (
            <>
              <svg className="w-3 h-3 text-[#4ADE80]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
              <span className="text-[#4ADE80]">Copied</span>
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
              </svg>
              Copy
            </>
          )}
        </button>
      </div>

      {/* Code content */}
      <div className="px-4 py-4 overflow-x-auto">
        <pre className="text-sm font-mono leading-relaxed">
          {lines.map((line, i) => (
            <div key={i} className="flex gap-4">
              {lines.length > 1 && (
                <span className="select-none text-[#3C4B5E] text-xs pt-px w-4 text-right flex-shrink-0">
                  {i + 1}
                </span>
              )}
              <span className={lang === "bash" ? "text-[#7DA0C7]" : "text-[#9CB8D5]"}>
                {lang === "bash" && <span className="text-[#4ADE80] select-none">$ </span>}
                {line}
              </span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

export default function Install() {
  return (
    <section id="install" className="py-32 relative overflow-hidden">
      {/* Background glow */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 60% 40% at 50% 100%, rgba(125,160,199,0.06) 0%, transparent 70%)",
        }}
      />

      <div className="max-w-6xl mx-auto px-6 relative">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-16"
        >
          <p className="text-sm font-mono text-[#7DA0C7] mb-3 tracking-widest uppercase">
            Installation
          </p>
          <h2 className="text-4xl font-bold tracking-tight mb-4">
            Get started in 30 seconds
          </h2>
          <p className="text-[#6B7280] max-w-md mx-auto">
            One install command. Then run it from any project directory.
          </p>
        </motion.div>

        <div className="max-w-2xl mx-auto">
          {/* Steps */}
          <div className="relative">
            {/* Vertical connector line */}
            <div className="absolute left-5 top-10 bottom-10 w-px bg-[rgba(255,255,255,0.06)] hidden sm:block" />

            <div className="space-y-8">
              {STEPS.map((step, i) => (
                <motion.div
                  key={step.number}
                  initial={{ opacity: 0, x: -20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: i * 0.12 }}
                  className="flex gap-6"
                >
                  {/* Step number */}
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-[rgba(125,160,199,0.1)] border border-[rgba(125,160,199,0.2)] flex items-center justify-center text-sm font-mono font-bold text-[#7DA0C7] z-10">
                    {step.number}
                  </div>

                  {/* Content */}
                  <div className="flex-1 pt-2">
                    <h3 className="font-semibold text-[#F5F5F5] mb-3">
                      {step.title}
                    </h3>
                    <CodeBlock code={step.code} lang={step.lang} />
                  </div>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Prerequisite note */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.4 }}
            className="mt-10 p-4 bg-[#111111] border border-[rgba(255,255,255,0.06)] rounded-lg"
          >
            <p className="text-xs text-[#6B7280] font-mono leading-relaxed">
              <span className="text-[#7DA0C7]">Note:</span> Requires Claude Code
              CLI.{" "}
              <code className="px-1.5 py-0.5 bg-[rgba(255,255,255,0.06)] rounded text-[#9CB8D5]">
                npm i -g @anthropic-ai/claude-code
              </code>
            </p>
          </motion.div>

          {/* CTA */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.5 }}
            className="mt-8 text-center"
          >
            <a
              href="https://github.com/Chai-B/CodeMaster"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-3 bg-[rgba(125,160,199,0.08)] border border-[rgba(125,160,199,0.2)] rounded-lg text-sm text-[#7DA0C7] font-medium hover:bg-[rgba(125,160,199,0.14)] transition-colors"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path
                  fillRule="evenodd"
                  d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                  clipRule="evenodd"
                />
              </svg>
              View source on GitHub
            </a>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
