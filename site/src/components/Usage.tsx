import { BlurFade } from './ui/BlurFade'
import { Terminal } from './ui/Terminal'
import type { TerminalLine } from './ui/Terminal'

const tuiLines: TerminalLine[] = [
  { text: '╭─ codemaster ──────────────────────────────────────────────────────────────╮', color: '#4f8ef7' },
  { text: '│  CodeMaster           │  Tips                                             │', color: '#4f8ef7' },
  { text: '│                       │  ─────────────────────────────────────────────   │', color: 'rgba(79,142,247,0.4)' },
  { text: '│  ▄████▄               │  Type a task to run the pipeline                 │', color: '#4f8ef7' },
  { text: '│  ██                   │  /help for commands                               │', color: '#4f8ef7' },
  { text: '│  ▀████▀               │                                                   │', color: '#4f8ef7' },
  { text: '│                       │  Recent                                           │', color: '#4f8ef7' },
  { text: '│  ~/myproject          │  03/13 10:42  fix divide by zero                 │', color: '#4f8ef7' },
  { text: '╰───────────────────────────────────────────────────────────────────────────╯', color: '#4f8ef7' },
  { text: ' files 3  fns 3  debug 2  claude claude', color: '#6b7280' },
  { text: '────────────────────────────────────────────────────────────────────────────', color: 'rgba(255,255,255,0.08)' },
  { text: '  ── TASK ──', color: '#4f8ef7', bold: true },
  { text: '  fix divide by zero in calculate_average  (BUG_FIX)', color: '#f0f0f8' },
  { text: '  Searching repository...', color: '#6b7280' },
  { text: '  Found 1 file(s): utils/math.py', color: '#34d399' },
  { text: '  (tokens) sending ~380 tokens (coder.md)', color: '#6b7280' },
  { text: '  --- utils/math.py  +++ utils/math.py', color: '#6b7280' },
  { text: '  @@ -12,3 +12,5 @@   def calculate_average(nums):', color: '#6b7280' },
  { text: '  -    return sum(nums) / len(nums)', color: '#f87171' },
  { text: '  +    if not nums:', color: '#34d399' },
  { text: '  +        return 0', color: '#34d399' },
  { text: '  +    return sum(nums) / len(nums)', color: '#34d399' },
  { text: '  ── RISK ──   Score: 1  LOW', color: '#34d399', bold: true },
  { text: '  ✓ Modified: utils/math.py', color: '#34d399' },
  { text: '────────────────────────────────────────────────────────────────────────────', color: 'rgba(255,255,255,0.08)' },
  { text: '❯ _', color: '#4f8ef7', bold: true },
  { text: '────────────────────────────────────────────────────────────────────────────', color: 'rgba(255,255,255,0.08)' },
  { text: ' ready  ·  Ctrl+Q quit  ·  Ctrl+L clear                codemaster v1.0.0  ·  myproject', color: '#6b7280' },
]

const commands = [
  { cmd: '/fix', desc: 'Fix a bug' },
  { cmd: '/refactor', desc: 'Refactor code' },
  { cmd: '/test', desc: 'Write or fix tests' },
  { cmd: '/explain', desc: 'Explain what code does' },
  { cmd: '/config', desc: 'Edit settings' },
  { cmd: '/agents', desc: 'Open agent prompts in $EDITOR' },
  { cmd: '/clear', desc: 'Clear output + reset repo map' },
  { cmd: '/cc', desc: 'Hand off to Claude Code' },
  { cmd: '/help', desc: 'Show all commands' },
]

const shortcuts = [
  { key: 'Ctrl+Q', desc: 'Quit' },
  { key: 'Ctrl+L', desc: 'Clear' },
  { key: 'Ctrl+C', desc: 'Interrupt running task' },
  { key: '↑↓', desc: 'Navigate autocomplete' },
]

const tips = [
  'Be specific — better task description = better code search',
  'Prefix with @claude to skip the pipeline and use Claude directly',
  'Check logs/calls.jsonl to see exact token usage per call',
]

export function Usage() {
  return (
    <section id="usage" className="py-24" style={{ background: '#08080f' }}>
      <div className="max-w-5xl mx-auto px-6">
        <BlurFade delay={0}>
          <div className="text-center mb-16">
            <p className="text-xs font-mono uppercase tracking-widest mb-3" style={{ color: '#4f8ef7' }}>
              Reference
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold" style={{ color: '#f0f0f8' }}>
              Using CodeMaster
            </h2>
          </div>
        </BlurFade>

        <div className="space-y-12">
          {/* Starting up */}
          <BlurFade delay={0.05}>
            <div>
              <h3 className="text-sm font-semibold mb-4" style={{ color: '#f0f0f8' }}>Starting up</h3>
              <Terminal
                title="shell"
                lines={[
                  { text: '$ cd your-project', color: '#c9d1d9' },
                  { text: '$ codemaster', color: '#c9d1d9' },
                ]}
              />
            </div>
          </BlurFade>

          {/* TUI Mockup */}
          <BlurFade delay={0.1}>
            <div>
              <h3 className="text-sm font-semibold mb-4" style={{ color: '#f0f0f8' }}>Live session</h3>
              <Terminal
                title="codemaster — ~/myproject"
                lines={tuiLines}
                className="text-xs"
              />
            </div>
          </BlurFade>

          {/* Commands + Shortcuts side by side */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <BlurFade delay={0.15}>
              <div>
                <h3 className="text-sm font-semibold mb-4" style={{ color: '#f0f0f8' }}>Commands</h3>
                <div
                  className="rounded-xl overflow-hidden"
                  style={{ border: '1px solid rgba(255,255,255,0.05)' }}
                >
                  {commands.map((c, i) => (
                    <div
                      key={c.cmd}
                      className="flex items-center gap-4 px-4 py-2.5"
                      style={{
                        borderTop: i > 0 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                        background: i % 2 === 0 ? '#020205' : '#08080f',
                      }}
                    >
                      <code
                        className="text-xs font-mono w-20 shrink-0"
                        style={{ color: '#4f8ef7' }}
                      >
                        {c.cmd}
                      </code>
                      <span className="text-sm" style={{ color: '#6b7280' }}>{c.desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </BlurFade>

            <BlurFade delay={0.2}>
              <div>
                <h3 className="text-sm font-semibold mb-4" style={{ color: '#f0f0f8' }}>Keyboard shortcuts</h3>
                <div
                  className="rounded-xl overflow-hidden"
                  style={{ border: '1px solid rgba(255,255,255,0.05)' }}
                >
                  {shortcuts.map((s, i) => (
                    <div
                      key={s.key}
                      className="flex items-center gap-4 px-4 py-2.5"
                      style={{
                        borderTop: i > 0 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                        background: i % 2 === 0 ? '#020205' : '#08080f',
                      }}
                    >
                      <kbd
                        className="text-xs font-mono px-1.5 py-0.5 rounded w-20 shrink-0 text-center"
                        style={{
                          background: 'rgba(255,255,255,0.06)',
                          border: '1px solid rgba(255,255,255,0.1)',
                          color: '#f0f0f8',
                        }}
                      >
                        {s.key}
                      </kbd>
                      <span className="text-sm" style={{ color: '#6b7280' }}>{s.desc}</span>
                    </div>
                  ))}
                </div>

                {/* Tips */}
                <div className="mt-6">
                  <h3 className="text-sm font-semibold mb-3" style={{ color: '#f0f0f8' }}>Tips</h3>
                  <div className="space-y-2">
                    {tips.map((tip, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span style={{ color: '#4f8ef7', marginTop: 2, fontSize: 10 }}>▸</span>
                        <p className="text-sm" style={{ color: '#6b7280' }}>{tip}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </BlurFade>
          </div>
        </div>
      </div>
    </section>
  )
}
