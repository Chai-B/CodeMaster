"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";

export default function NavBar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <motion.header
      initial={{ opacity: 0, y: -16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-[rgba(8,8,8,0.85)] backdrop-blur-md border-b border-[rgba(255,255,255,0.06)]"
          : "bg-transparent"
      }`}
    >
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        {/* Logo */}
        <a
          href="#"
          className="flex items-center gap-2.5 hover:opacity-80 transition-opacity"
        >
          <span className="font-mono text-xs font-bold text-[#7DA0C7] bg-[rgba(125,160,199,0.1)] border border-[rgba(125,160,199,0.2)] px-1.5 py-0.5 rounded select-none">
            &gt;_
          </span>
          <span className="font-mono text-sm font-semibold text-[#F5F5F5] tracking-tight">
            CodeMaster
          </span>
        </a>

        {/* Center nav — desktop only */}
        <nav className="hidden md:flex items-center gap-1">
          {[
            { label: "Features", href: "#features" },
            { label: "Pipeline", href: "#pipeline" },
            { label: "Commands", href: "#commands" },
            { label: "Install", href: "#install" },
          ].map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="px-3 py-1.5 text-sm text-[#6B7280] hover:text-[#F5F5F5] transition-colors rounded-md hover:bg-[rgba(255,255,255,0.04)]"
            >
              {link.label}
            </a>
          ))}
        </nav>

        {/* Right CTA */}
        <Button
          variant="outline"
          size="sm"
          href="https://github.com/Chai-B/CodeMaster"
        >
          <svg
            className="w-4 h-4"
            fill="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
              clipRule="evenodd"
            />
          </svg>
          GitHub
        </Button>
      </div>
    </motion.header>
  );
}
