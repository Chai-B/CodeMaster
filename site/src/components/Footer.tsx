import { Github, ExternalLink } from 'lucide-react'

export function Footer() {
  return (
    <footer
      className="py-12 px-6"
      style={{
        background: '#020205',
        borderTop: '1px solid rgba(255,255,255,0.05)',
      }}
    >
      <div className="max-w-6xl mx-auto">
        {/* Main row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 mb-8">
          {/* Left */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="font-mono text-sm" style={{ color: '#4f8ef7' }}>▄████▄</span>
              <span className="font-semibold text-sm" style={{ color: '#f0f0f8' }}>CodeMaster</span>
            </div>
            <p className="text-xs leading-relaxed" style={{ color: '#6b7280' }}>
              Work in progress — more coming.
            </p>
          </div>

          {/* Center */}
          <div className="flex flex-col items-start sm:items-center gap-2">
            <a
              href="https://github.com/Chai-B/CodeMaster"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-sm transition-colors duration-200 hover:text-white"
              style={{ color: '#6b7280' }}
            >
              <Github size={13} />
              GitHub
            </a>
            <a
              href="https://github.com/Chai-B/CodeMaster/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-sm transition-colors duration-200 hover:text-white"
              style={{ color: '#6b7280' }}
            >
              <ExternalLink size={13} />
              Issues
            </a>
          </div>

          {/* Right */}
          <div className="sm:text-right">
            <p className="text-xs" style={{ color: '#6b7280' }}>
              Powered by{' '}
              <a
                href="https://claude.ai/code"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline transition-colors duration-200"
                style={{ color: '#4f8ef7' }}
              >
                Claude Code
              </a>
            </p>
          </div>
        </div>

        {/* Bottom line */}
        <div
          className="pt-6"
          style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
        >
          <p className="text-xs text-center" style={{ color: 'rgba(107,114,128,0.5)' }}>
            MIT License
          </p>
        </div>
      </div>
    </footer>
  )
}
