import { useState } from 'react'
import { motion } from 'framer-motion'
import { BlurFade } from './ui/BlurFade'

interface FeatureCardProps {
  title: string
  children: React.ReactNode
  className?: string
  accent?: string
}

function FeatureCard({ title, children, className = '', accent = '#4f8ef7' }: FeatureCardProps) {
  const [hovered, setHovered] = useState(false)
  return (
    <motion.div
      className={`rounded-xl p-6 relative overflow-hidden ${className}`}
      style={{
        background: '#020205',
        border: '1px solid rgba(255,255,255,0.05)',
        transition: 'box-shadow 0.3s ease, border-color 0.3s ease',
        borderColor: hovered ? `${accent}30` : 'rgba(255,255,255,0.05)',
        boxShadow: hovered ? `0 0 30px ${accent}10` : 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      whileHover={{ y: -1 }}
      transition={{ duration: 0.2 }}
    >
      {/* Top accent line */}
      <div
        className="absolute top-0 left-0 right-0 h-px transition-opacity duration-300"
        style={{
          background: `linear-gradient(90deg, transparent, ${accent}60, transparent)`,
          opacity: hovered ? 1 : 0,
        }}
      />

      <h3 className="text-sm font-semibold mb-3" style={{ color: '#f0f0f8' }}>
        {title}
      </h3>
      {children}
    </motion.div>
  )
}

export function Features() {
  return (
    <section className="py-24" style={{ background: '#08080f' }}>
      <div className="max-w-6xl mx-auto px-6">
        <BlurFade delay={0}>
          <div className="text-center mb-16">
            <p className="text-xs font-mono uppercase tracking-widest mb-3" style={{ color: '#4f8ef7' }}>
              Architecture
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold" style={{ color: '#f0f0f8' }}>
              Built Different
            </h2>
            <p className="mt-3 text-base" style={{ color: '#6b7280' }}>
              Every design decision optimizes for fewer tokens and faster iteration.
            </p>
          </div>
        </BlurFade>

        {/* Bento grid */}
        <div className="space-y-4">
          {/* Row 1: 2/3 + 1/3 */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <BlurFade delay={0.05} className="lg:col-span-2">
              <FeatureCard title="Token-efficient by design" accent="#4f8ef7">
                <p className="text-sm mb-4" style={{ color: '#6b7280' }}>
                  Every step is calibrated to minimize LLM calls and token usage. Complex tasks scale up; simple ones stay lean.
                </p>
                <div className="rounded-lg overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                  <table className="w-full text-xs font-mono">
                    <thead>
                      <tr style={{ background: 'rgba(79,142,247,0.06)' }}>
                        <th className="text-left px-3 py-2" style={{ color: '#4f8ef7' }}>Task type</th>
                        <th className="text-left px-3 py-2" style={{ color: '#4f8ef7' }}>LLM calls</th>
                        <th className="text-left px-3 py-2" style={{ color: '#4f8ef7' }}>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ['Simple bug fix', '1 call', 'Coder only'],
                        ['Complex feature', 'N × 2–3 calls', 'Planner + coder per step'],
                        ['Patch retry', '2 calls', 'Issue summary + diff only'],
                        ['Low-risk change', 'No reviewer', 'Skip straight to apply'],
                      ].map(([task, calls, note], i) => (
                        <tr
                          key={i}
                          style={{
                            borderTop: '1px solid rgba(255,255,255,0.04)',
                            background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                          }}
                        >
                          <td className="px-3 py-2" style={{ color: '#f0f0f8' }}>{task}</td>
                          <td className="px-3 py-2" style={{ color: '#34d399' }}>{calls}</td>
                          <td className="px-3 py-2" style={{ color: '#6b7280' }}>{note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </FeatureCard>
            </BlurFade>

            <BlurFade delay={0.1}>
              <FeatureCard title="Risk-gated review" accent="#7c55f5">
                <p className="text-sm leading-relaxed mb-4" style={{ color: '#6b7280' }}>
                  The reviewer agent only fires on medium or high risk patches. Low risk changes skip straight to apply — no unnecessary round trips.
                </p>
                <div className="space-y-2">
                  {[
                    { label: 'Low risk', color: '#34d399', desc: 'Skip → apply directly' },
                    { label: 'Medium risk', color: '#f59e0b', desc: 'Reviewer fires' },
                    { label: 'High risk', color: '#f87171', desc: 'Reviewer + confirm' },
                  ].map(item => (
                    <div key={item.label} className="flex items-center gap-2">
                      <div
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: item.color }}
                      />
                      <span className="text-xs font-mono" style={{ color: item.color }}>{item.label}</span>
                      <span className="text-xs" style={{ color: '#6b7280' }}>— {item.desc}</span>
                    </div>
                  ))}
                </div>
              </FeatureCard>
            </BlurFade>
          </div>

          {/* Row 2: small + small + medium */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <BlurFade delay={0.12}>
              <FeatureCard title="Targeted lint" accent="#34d399">
                <p className="text-sm leading-relaxed" style={{ color: '#6b7280' }}>
                  Static analysis runs only on changed files, not the entire project. Ruff, flake8, and isort check only what was modified.
                </p>
                <div
                  className="mt-4 px-3 py-2 rounded-lg text-xs font-mono"
                  style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.12)', color: '#34d399' }}
                >
                  ruff check utils/math.py<br />
                  <span style={{ color: '#6b7280' }}># not ruff check .</span>
                </div>
              </FeatureCard>
            </BlurFade>

            <BlurFade delay={0.14}>
              <FeatureCard title="Smart planner" accent="#4f8ef7">
                <p className="text-sm leading-relaxed" style={{ color: '#6b7280' }}>
                  BUG_FIX, TEST, and DOCS tasks skip the planner automatically. The pipeline detects task type and routes accordingly.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {['BUG_FIX', 'TEST', 'DOCS'].map(tag => (
                    <span
                      key={tag}
                      className="px-2 py-1 rounded text-xs font-mono"
                      style={{
                        background: 'rgba(79,142,247,0.08)',
                        border: '1px solid rgba(79,142,247,0.15)',
                        color: '#4f8ef7',
                      }}
                    >
                      {tag}
                    </span>
                  ))}
                  <span className="text-xs self-center" style={{ color: '#6b7280' }}>→ skip planner</span>
                </div>
              </FeatureCard>
            </BlurFade>

            <BlurFade delay={0.16}>
              <FeatureCard title="Agent prompts" accent="#7c55f5">
                <p className="text-sm leading-relaxed mb-4" style={{ color: '#6b7280' }}>
                  Four specialized agents handle distinct roles. Edit their system prompts directly with{' '}
                  <code className="px-1 py-0.5 rounded text-xs" style={{ background: 'rgba(124,85,245,0.12)', color: '#7c55f5' }}>/agents</code>
                  {' '}in $EDITOR.
                </p>
                <div className="grid grid-cols-2 gap-1">
                  {['planner', 'coder', 'reviewer', 'patcher'].map(agent => (
                    <div
                      key={agent}
                      className="px-2 py-1.5 rounded text-xs font-mono text-center"
                      style={{
                        background: 'rgba(124,85,245,0.06)',
                        border: '1px solid rgba(124,85,245,0.12)',
                        color: '#a78bfa',
                      }}
                    >
                      {agent}
                    </div>
                  ))}
                </div>
              </FeatureCard>
            </BlurFade>
          </div>
        </div>
      </div>
    </section>
  )
}
