import { useState } from 'react'
import { motion } from 'framer-motion'
import { Zap, Shield, Crosshair } from 'lucide-react'
import { BlurFade } from './ui/BlurFade'
import { BorderBeam } from './ui/BorderBeam'

const cards = [
  {
    icon: <Zap size={20} />,
    emoji: '⚡',
    title: 'Fast',
    body: 'One LLM call for bug fixes. Simple tasks stay simple. No orchestration overhead for work that doesn\'t need it.',
    color: '#4f8ef7',
  },
  {
    icon: <Shield size={20} />,
    emoji: '🔒',
    title: 'Safe',
    body: 'Always shows the diff before applying. Nothing changes without your approval. Risk scoring on every patch.',
    color: '#7c55f5',
  },
  {
    icon: <Crosshair size={20} />,
    emoji: '🎯',
    title: 'Precise',
    body: 'Searches without tokens. Context extracted at function level, not whole files. ~80% less context sent to the LLM.',
    color: '#34d399',
  },
]

export function Highlights() {
  const [hovered, setHovered] = useState<number | null>(null)

  return (
    <section className="py-24" style={{ background: '#08080f' }}>
      <div className="max-w-6xl mx-auto px-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {cards.map((card, i) => (
            <BlurFade key={i} delay={i * 0.1}>
              <motion.div
                className="relative rounded-xl p-6 cursor-default"
                style={{
                  background: '#020205',
                  border: '1px solid rgba(255,255,255,0.05)',
                  transition: 'box-shadow 0.3s ease',
                  boxShadow: hovered === i
                    ? `0 0 30px ${card.color}18, 0 0 60px ${card.color}08`
                    : 'none',
                }}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                whileHover={{ y: -2 }}
                transition={{ duration: 0.2 }}
              >
                {hovered === i && <BorderBeam duration={3} colorFrom={card.color} colorTo={card.color === '#4f8ef7' ? '#7c55f5' : '#4f8ef7'} />}

                {/* Inner content masked above border beam */}
                <div
                  className="absolute inset-px rounded-[11px]"
                  style={{ background: '#020205', zIndex: 1 }}
                />

                <div className="relative z-10">
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center mb-4 text-lg"
                    style={{
                      background: `${card.color}14`,
                      border: `1px solid ${card.color}22`,
                      color: card.color,
                    }}
                  >
                    {card.emoji}
                  </div>
                  <h3 className="text-base font-semibold mb-2" style={{ color: '#f0f0f8' }}>
                    {card.title}
                  </h3>
                  <p className="text-sm leading-relaxed" style={{ color: '#6b7280' }}>
                    {card.body}
                  </p>
                </div>
              </motion.div>
            </BlurFade>
          ))}
        </div>
      </div>
    </section>
  )
}
