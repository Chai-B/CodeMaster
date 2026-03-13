import { motion, type Variants } from 'framer-motion'
import { cn } from '../../lib/utils'

interface BlurFadeProps {
  children: React.ReactNode
  delay?: number
  direction?: 'up' | 'left'
  className?: string
  duration?: number
}

export function BlurFade({ children, delay = 0, direction = 'up', className, duration = 0.5 }: BlurFadeProps) {
  const variants: Variants = {
    hidden: {
      opacity: 0,
      filter: 'blur(6px)',
      y: direction === 'up' ? 20 : 0,
      x: direction === 'left' ? 20 : 0,
    },
    visible: {
      opacity: 1,
      filter: 'blur(0px)',
      y: 0,
      x: 0,
    },
  }

  return (
    <motion.div
      className={cn(className)}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: '-50px' }}
      transition={{ duration, delay, ease: [0.21, 0.47, 0.32, 0.98] }}
      variants={variants}
    >
      {children}
    </motion.div>
  )
}
