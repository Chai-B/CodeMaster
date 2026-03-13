import { cn } from '../../lib/utils'

interface SpotlightProps {
  className?: string
  color?: string
}

export function Spotlight({ className, color = 'rgba(79,142,247,0.12)' }: SpotlightProps) {
  return (
    <div
      aria-hidden
      className={cn('pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 h-[600px] w-[600px] rounded-full', className)}
      style={{
        background: `radial-gradient(circle, ${color} 0%, rgba(79,142,247,0.04) 40%, transparent 70%)`,
      }}
    />
  )
}
