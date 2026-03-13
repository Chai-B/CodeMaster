import { motion } from 'framer-motion'
import { BlurFade } from './ui/BlurFade'

const steps = [
  {
    n: 1,
    title: 'Search',
    lines: ['No LLM. grep +', 'repo map finds', 'relevant files.'],
  },
  {
    n: 2,
    title: 'Context',
    lines: ['Function-level', 'extraction.', '~80% less ctx.'],
  },
  {
    n: 3,
    title: 'Generate',
    lines: ['Claude writes', 'a unified diff.', ''],
  },
  {
    n: 4,
    title: 'Validate',
    lines: ['py_compile +', 'patch simulation.', 'Syntax check.'],
  },
  {
    n: 5,
    title: 'Review',
    lines: ['Risk scoring.', 'Reviewer only if', 'medium/high risk.'],
  },
  {
    n: 6,
    title: 'Apply',
    lines: ['You see the diff.', 'You confirm.', 'Changes applied.'],
  },
]

export function Pipeline() {
  return (
    <section id="pipeline" className="py-24" style={{ background: '#020205' }}>
      <div className="max-w-6xl mx-auto px-6">
        <BlurFade delay={0}>
          <div className="text-center mb-16">
            <p className="text-xs font-mono uppercase tracking-widest mb-3" style={{ color: '#4f8ef7' }}>
              The pipeline
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold" style={{ color: '#f0f0f8' }}>
              How It Works
            </h2>
            <p className="mt-3 text-base" style={{ color: '#6b7280' }}>
              Six deterministic steps from task to applied patch.
            </p>
          </div>
        </BlurFade>

        {/* Steps grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          {steps.map((step, i) => (
            <BlurFade key={step.n} delay={i * 0.08}>
              <div className="relative flex flex-col items-center text-center">
                {/* Connector arrow (not on last in row) */}
                {i < steps.length - 1 && (
                  <div
                    className="hidden lg:block absolute top-5 left-full w-4 text-center z-10 -translate-y-1/2"
                    style={{ color: 'rgba(79,142,247,0.3)', fontSize: 14 }}
                  >
                    →
                  </div>
                )}

                <motion.div
                  className="w-full rounded-xl p-4"
                  style={{
                    background: '#08080f',
                    border: '1px solid rgba(255,255,255,0.05)',
                  }}
                  whileHover={{
                    borderColor: 'rgba(79,142,247,0.3)',
                    boxShadow: '0 0 20px rgba(79,142,247,0.08)',
                  }}
                  transition={{ duration: 0.2 }}
                >
                  {/* Step number */}
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center mx-auto mb-3 text-sm font-bold font-mono"
                    style={{
                      background: 'rgba(79,142,247,0.12)',
                      border: '1px solid rgba(79,142,247,0.25)',
                      color: '#4f8ef7',
                    }}
                  >
                    {step.n}
                  </div>

                  <div className="text-sm font-semibold mb-2" style={{ color: '#f0f0f8' }}>
                    {step.title}
                  </div>

                  <div className="space-y-0.5">
                    {step.lines.map((line, j) => (
                      <div key={j} className="text-xs leading-relaxed" style={{ color: '#6b7280' }}>
                        {line || '\u00a0'}
                      </div>
                    ))}
                  </div>
                </motion.div>
              </div>
            </BlurFade>
          ))}
        </div>

        {/* Mobile arrow connector */}
        <div className="flex justify-center mt-8 lg:hidden">
          <div className="flex items-center gap-1">
            {steps.map((step, i) => (
              <div key={step.n} className="flex items-center gap-1">
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-mono font-bold"
                  style={{
                    background: 'rgba(79,142,247,0.12)',
                    border: '1px solid rgba(79,142,247,0.25)',
                    color: '#4f8ef7',
                  }}
                >
                  {step.n}
                </div>
                {i < steps.length - 1 && (
                  <span style={{ color: 'rgba(79,142,247,0.4)', fontSize: 11 }}>→</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
