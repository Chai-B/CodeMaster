import { useEffect, useState } from 'react'
import { motion, useScroll, useTransform } from 'framer-motion'
import { Github, Download } from 'lucide-react'

export function Nav() {
  const [scrolled, setScrolled] = useState(false)
  const { scrollY } = useScroll()

  const bgOpacity = useTransform(scrollY, [0, 80], [0, 1])
  const borderOpacity = useTransform(scrollY, [0, 80], [0, 1])

  useEffect(() => {
    const unsub = scrollY.on('change', v => setScrolled(v > 20))
    return unsub
  }, [scrollY])

  return (
    <motion.nav
      className="fixed top-0 left-0 right-0 z-50 frosted"
      style={{}}
    >
      <motion.div
        className="absolute inset-0"
        style={{
          background: 'rgba(2,2,5,0.85)',
          opacity: bgOpacity,
          borderBottom: '1px solid rgba(255,255,255,0.07)',
        }}
      />
      <div className="relative max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        {/* Logo */}
        <a href="#" className="flex items-center gap-2 group">
          <span
            className="font-mono text-sm leading-none"
            style={{ color: '#4f8ef7' }}
          >
            {'▄████▄'}
          </span>
          <span className="font-semibold text-sm tracking-wide" style={{ color: '#f0f0f8' }}>
            CodeMaster
          </span>
        </a>

        {/* Right links */}
        <div className="flex items-center gap-1">
          <a
            href="https://github.com/Chai-B/CodeMaster"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-all duration-200"
            style={{ color: '#6b7280' }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLAnchorElement).style.color = '#f0f0f8'
              ;(e.currentTarget as HTMLAnchorElement).style.background = 'rgba(255,255,255,0.05)'
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLAnchorElement).style.color = '#6b7280'
              ;(e.currentTarget as HTMLAnchorElement).style.background = 'transparent'
            }}
          >
            <Github size={14} />
            <span>GitHub</span>
          </a>
          <a
            href="#installation"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg font-medium transition-all duration-200"
            style={{
              background: 'rgba(79,142,247,0.12)',
              color: '#4f8ef7',
              border: '1px solid rgba(79,142,247,0.2)',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(79,142,247,0.2)'
              ;(e.currentTarget as HTMLAnchorElement).style.borderColor = 'rgba(79,142,247,0.4)'
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(79,142,247,0.12)'
              ;(e.currentTarget as HTMLAnchorElement).style.borderColor = 'rgba(79,142,247,0.2)'
            }}
          >
            <Download size={13} />
            <span>Install</span>
          </a>
        </div>
      </div>
    </motion.nav>
  )
}
