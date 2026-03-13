import { useState } from 'react'
import { Copy, Check, ExternalLink } from 'lucide-react'
import { BlurFade } from './ui/BlurFade'

function CopyBlock({ code, language = 'bash' }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className="relative rounded-xl overflow-hidden"
      style={{ background: '#0d1117', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-4 py-2 border-b"
        style={{ borderColor: 'rgba(255,255,255,0.04)', background: '#0a0e14' }}
      >
        <span className="text-xs font-mono" style={{ color: '#6b7280' }}>{language}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-all duration-200"
          style={{
            color: copied ? '#34d399' : '#6b7280',
            background: copied ? 'rgba(52,211,153,0.08)' : 'transparent',
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        className="p-4 overflow-x-auto text-sm font-mono leading-relaxed"
        style={{ color: '#c9d1d9' }}
      >
        {code.split('\n').map((line, i) => (
          <div key={i}>
            {line.startsWith('#') ? (
              <span style={{ color: '#6b7280' }}>{line}</span>
            ) : line.startsWith('cd ') || line.startsWith('bash ') ? (
              <>
                <span style={{ color: '#4f8ef7' }}>$ </span>
                <span>{line}</span>
              </>
            ) : line.startsWith('curl') || line.startsWith('git') ? (
              <>
                <span style={{ color: '#4f8ef7' }}>$ </span>
                <span>{line}</span>
              </>
            ) : (
              <span>{line}</span>
            )}
          </div>
        ))}
      </pre>
    </div>
  )
}

const PREREQS = [
  { label: 'Python 3.10+', required: true },
  { label: 'Node.js 18+', required: true },
  { label: 'Claude Code CLI', required: true, link: 'https://claude.ai/code' },
  { label: 'ruff, flake8, isort', required: false, note: 'optional' },
]

const WHAT_IT_DOES = [
  { n: 1, text: 'Checks prerequisites (Python 3.10+, Node.js, Claude CLI)' },
  { n: 2, text: 'Installs to ~/.codemaster and runs npm install' },
  { n: 3, text: 'Links codemaster to /usr/local/bin' },
]

export function Installation() {
  return (
    <section id="installation" className="py-24" style={{ background: '#020205' }}>
      <div className="max-w-3xl mx-auto px-6">
        <BlurFade delay={0}>
          <div className="text-center mb-16">
            <p className="text-xs font-mono uppercase tracking-widest mb-3" style={{ color: '#4f8ef7' }}>
              Setup
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold" style={{ color: '#f0f0f8' }}>
              Get Started in 30 Seconds
            </h2>
          </div>
        </BlurFade>

        <div className="space-y-10">
          {/* Prerequisites */}
          <BlurFade delay={0.05}>
            <div>
              <h3 className="text-sm font-semibold mb-4" style={{ color: '#f0f0f8' }}>Prerequisites</h3>
              <div className="space-y-2">
                {PREREQS.map((p, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div
                      className="w-4 h-4 rounded flex items-center justify-center shrink-0"
                      style={{ background: p.required ? 'rgba(79,142,247,0.15)' : 'rgba(107,114,128,0.15)' }}
                    >
                      <Check size={10} style={{ color: p.required ? '#4f8ef7' : '#6b7280' }} />
                    </div>
                    <span className="text-sm" style={{ color: '#f0f0f8' }}>
                      {p.link ? (
                        <a
                          href={p.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 hover:underline"
                          style={{ color: '#4f8ef7' }}
                        >
                          {p.label}
                          <ExternalLink size={11} />
                        </a>
                      ) : p.label}
                    </span>
                    {p.note && (
                      <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'rgba(107,114,128,0.1)', color: '#6b7280' }}>
                        {p.note}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </BlurFade>

          {/* Method 1 */}
          <BlurFade delay={0.1}>
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span
                  className="text-xs font-mono px-2 py-0.5 rounded"
                  style={{ background: 'rgba(79,142,247,0.1)', border: '1px solid rgba(79,142,247,0.2)', color: '#4f8ef7' }}
                >
                  Method 1
                </span>
                <h3 className="text-sm font-semibold" style={{ color: '#f0f0f8' }}>One command</h3>
              </div>
              <CopyBlock code="curl -fsSL https://raw.githubusercontent.com/Chai-B/CodeMaster/main/install.sh | bash" />
            </div>
          </BlurFade>

          {/* Method 2 */}
          <BlurFade delay={0.15}>
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span
                  className="text-xs font-mono px-2 py-0.5 rounded"
                  style={{ background: 'rgba(124,85,245,0.1)', border: '1px solid rgba(124,85,245,0.2)', color: '#7c55f5' }}
                >
                  Method 2
                </span>
                <h3 className="text-sm font-semibold" style={{ color: '#f0f0f8' }}>Clone</h3>
              </div>
              <CopyBlock code={`git clone https://github.com/Chai-B/CodeMaster\ncd CodeMaster\nbash install.sh`} />
            </div>
          </BlurFade>

          {/* What it does */}
          <BlurFade delay={0.2}>
            <div
              className="rounded-xl p-5"
              style={{ background: '#08080f', border: '1px solid rgba(255,255,255,0.05)' }}
            >
              <h3 className="text-sm font-semibold mb-4" style={{ color: '#f0f0f8' }}>What install.sh does</h3>
              <div className="space-y-3">
                {WHAT_IT_DOES.map(step => (
                  <div key={step.n} className="flex items-start gap-3">
                    <div
                      className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 text-xs font-mono font-bold"
                      style={{ background: 'rgba(79,142,247,0.12)', color: '#4f8ef7', border: '1px solid rgba(79,142,247,0.2)' }}
                    >
                      {step.n}
                    </div>
                    <p className="text-sm leading-relaxed" style={{ color: '#6b7280' }}>
                      {step.text.includes('~/.codemaster') ? (
                        <>
                          Installs to{' '}
                          <code className="px-1 py-0.5 rounded text-xs font-mono" style={{ background: 'rgba(255,255,255,0.06)', color: '#c9d1d9' }}>~/.codemaster</code>
                          {' '}and runs{' '}
                          <code className="px-1 py-0.5 rounded text-xs font-mono" style={{ background: 'rgba(255,255,255,0.06)', color: '#c9d1d9' }}>npm install</code>
                        </>
                      ) : step.text.includes('/usr/local/bin') ? (
                        <>
                          Links{' '}
                          <code className="px-1 py-0.5 rounded text-xs font-mono" style={{ background: 'rgba(255,255,255,0.06)', color: '#c9d1d9' }}>codemaster</code>
                          {' '}to{' '}
                          <code className="px-1 py-0.5 rounded text-xs font-mono" style={{ background: 'rgba(255,255,255,0.06)', color: '#c9d1d9' }}>/usr/local/bin</code>
                        </>
                      ) : step.text}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </BlurFade>
        </div>
      </div>
    </section>
  )
}
