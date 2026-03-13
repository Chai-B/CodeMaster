import { useState } from 'react'
import { motion } from 'framer-motion'
import { Copy, Check, Github, ChevronDown } from 'lucide-react'
import { BlurFade } from './ui/BlurFade'
import { GradientText } from './ui/GradientText'
import { Spotlight } from './ui/Spotlight'

const INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/Chai-B/CodeMaster/main/install.sh | bash'

export function Hero() {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(INSTALL_CMD)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <section
      className="relative min-h-screen flex flex-col items-center justify-center dot-grid overflow-hidden"
      style={{ background: '#020205' }}
    >
      <Spotlight />

      {/* Extra subtle purple glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/4 right-1/4 h-[400px] w-[400px] rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(124,85,245,0.06) 0%, transparent 70%)',
        }}
      />

      {/* Bottom fade */}
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0 right-0 h-40"
        style={{
          background: 'linear-gradient(to bottom, transparent, #020205)',
        }}
      />

      <div className="relative z-10 flex flex-col items-center text-center px-6 max-w-4xl mx-auto pt-20 pb-16">
        {/* ASCII art logo */}
        <BlurFade delay={0}>
          <pre
            className="text-xs sm:text-sm leading-tight mb-8 select-none"
            style={{ color: '#4f8ef7', fontFamily: '"JetBrains Mono", monospace' }}
          >{`  ▄████▄   ▄██████▄  ██████████  ████████  ██     ██   ██████    ███████  ████████  ████████ ████████
 ██        ██    ██  ██          ██        ███   ███  ██   ██  ██   ██  ██        ██       ██    ██
 ██        ██    ██  ██          ██        ████ ████  ██   ██  ██   ██  ██        ██       ██    ██
 ██        ██    ██  ██          ██████    ██ ███ ██  ████████  ██████   ██████   ██████   ████████
 ██        ██    ██  ██          ██        ██  █  ██  ██   ██        ██      ██   ██       ██  ██
 ██        ██    ██  ██          ██        ██     ██  ██   ██   ██   ██      ██   ██       ██   ██
  ▀████▀   ▀██████▀  ██████████  ████████  ██     ██  ██   ██  ██████   ███████  ████████  ██    ██`}</pre>
        </BlurFade>

        {/* Badge */}
        <BlurFade delay={0.05}>
          <div className="mb-6 inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-mono relative overflow-hidden"
            style={{
              background: 'rgba(79,142,247,0.08)',
              border: '1px solid rgba(79,142,247,0.2)',
              color: '#4f8ef7',
            }}
          >
            <div
              className="absolute inset-0 opacity-0 hover:opacity-100 transition-opacity duration-500"
              style={{
                background: 'linear-gradient(90deg, transparent, rgba(79,142,247,0.1), transparent)',
                animation: 'shimmer-slide 2s ease infinite',
              }}
            />
            <span className="relative">v1.0.0</span>
            <span className="relative" style={{ color: 'rgba(79,142,247,0.5)' }}>·</span>
            <span className="relative">Open Source</span>
          </div>
        </BlurFade>

        {/* H1 */}
        <BlurFade delay={0.1}>
          <h1 className="text-6xl sm:text-7xl font-bold tracking-tight mb-6">
            <GradientText>CodeMaster</GradientText>
          </h1>
        </BlurFade>

        {/* Subtitle */}
        <BlurFade delay={0.2}>
          <div className="mb-10 space-y-1">
            <p className="text-xl sm:text-2xl font-medium" style={{ color: '#f0f0f8' }}>
              AI coding assistant for your terminal.
            </p>
            <p className="text-base sm:text-lg" style={{ color: '#6b7280' }}>
              Describe a task, get a patch. Powered by Claude Code.
            </p>
          </div>
        </BlurFade>

        {/* Install pill */}
        <BlurFade delay={0.3}>
          <div
            className="flex items-center gap-0 mb-8 rounded-xl overflow-hidden max-w-full sm:max-w-2xl w-full"
            style={{
              background: '#08080f',
              border: '1px solid rgba(79,142,247,0.2)',
              boxShadow: '0 0 20px rgba(79,142,247,0.08)',
            }}
          >
            <span
              className="px-4 py-3 text-xs sm:text-sm font-mono flex-1 overflow-x-auto whitespace-nowrap select-all"
              style={{ color: '#6b7280' }}
            >
              <span style={{ color: '#4f8ef7' }}>$</span>{' '}
              <span style={{ color: '#c9d1d9' }}>{INSTALL_CMD}</span>
            </span>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-4 py-3 text-xs font-medium transition-all duration-200 shrink-0 border-l"
              style={{
                borderColor: 'rgba(79,142,247,0.15)',
                color: copied ? '#34d399' : '#4f8ef7',
                background: copied ? 'rgba(52,211,153,0.08)' : 'rgba(79,142,247,0.05)',
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              <span>{copied ? 'Copied!' : 'Copy'}</span>
            </button>
          </div>
        </BlurFade>

        {/* CTA buttons */}
        <BlurFade delay={0.4}>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <a
              href="https://github.com/Chai-B/CodeMaster"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all duration-200"
              style={{
                background: '#f0f0f8',
                color: '#020205',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLAnchorElement).style.background = '#ffffff'
                ;(e.currentTarget as HTMLAnchorElement).style.boxShadow = '0 0 20px rgba(240,240,248,0.15)'
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLAnchorElement).style.background = '#f0f0f8'
                ;(e.currentTarget as HTMLAnchorElement).style.boxShadow = 'none'
              }}
            >
              <Github size={15} />
              View on GitHub
            </a>
            <a
              href="#pipeline"
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all duration-200"
              style={{
                background: 'transparent',
                color: '#6b7280',
                border: '1px solid rgba(255,255,255,0.07)',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLAnchorElement).style.color = '#f0f0f8'
                ;(e.currentTarget as HTMLAnchorElement).style.borderColor = 'rgba(255,255,255,0.15)'
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLAnchorElement).style.color = '#6b7280'
                ;(e.currentTarget as HTMLAnchorElement).style.borderColor = 'rgba(255,255,255,0.07)'
              }}
            >
              See how it works
              <ChevronDown size={14} />
            </a>
          </div>
        </BlurFade>
      </div>

      {/* Scroll indicator */}
      <motion.div
        className="absolute bottom-8 left-1/2 -translate-x-1/2"
        animate={{ y: [0, 6, 0] }}
        transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
      >
        <ChevronDown size={18} style={{ color: 'rgba(255,255,255,0.2)' }} />
      </motion.div>
    </section>
  )
}
