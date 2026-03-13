import { motion } from 'framer-motion'

interface BorderBeamProps {
  duration?: number
  colorFrom?: string
  colorTo?: string
}

export function BorderBeam({ duration = 4, colorFrom = '#4f8ef7', colorTo = '#7c55f5' }: BorderBeamProps) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: 'inherit',
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <motion.div
        style={{
          background: `conic-gradient(from 0deg, transparent 75%, ${colorFrom} 88%, ${colorTo} 94%, transparent)`,
          position: 'absolute',
          inset: '-50%',
          borderRadius: '50%',
          width: '200%',
          height: '200%',
        }}
        animate={{ rotate: 360 }}
        transition={{ duration, ease: 'linear', repeat: Infinity }}
      />
    </div>
  )
}
