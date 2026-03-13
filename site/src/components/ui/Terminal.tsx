import { cn } from '../../lib/utils'

export interface TerminalLine {
  text: string
  color?: string
  bold?: boolean
  dim?: boolean
  indent?: number
}

interface TerminalProps {
  lines: TerminalLine[]
  title?: string
  className?: string
  showCursor?: boolean
}

export function Terminal({ lines, title = 'terminal', className, showCursor = false }: TerminalProps) {
  return (
    <div
      className={cn(
        'rounded-xl overflow-hidden border border-white/5',
        className
      )}
      style={{ background: '#0d1117', fontFamily: '"JetBrains Mono", "Fira Code", monospace' }}
    >
      {/* Title bar */}
      <div
        className="flex items-center gap-2 px-4 py-3 border-b border-white/5"
        style={{ background: '#0a0e14' }}
      >
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-500/80" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
          <div className="w-3 h-3 rounded-full bg-green-500/80" />
        </div>
        <span className="ml-2 text-xs text-white/30 font-mono">{title}</span>
      </div>

      {/* Content */}
      <div className="p-4 text-sm leading-relaxed overflow-x-auto">
        {lines.map((line, i) => (
          <div
            key={i}
            style={{
              color: line.color ?? '#c9d1d9',
              fontWeight: line.bold ? 600 : 400,
              opacity: line.dim ? 0.45 : 1,
              paddingLeft: line.indent ? `${line.indent * 1}rem` : undefined,
              whiteSpace: 'pre',
            }}
          >
            {line.text || '\u00a0'}
          </div>
        ))}
        {showCursor && (
          <span
            className="cursor-blink inline-block w-2 h-4 ml-0.5"
            style={{ background: '#4f8ef7', verticalAlign: 'text-bottom' }}
          />
        )}
      </div>
    </div>
  )
}
