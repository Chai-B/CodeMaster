import { cn } from '../../lib/utils'

interface GradientTextProps {
  children: React.ReactNode
  className?: string
  as?: keyof React.JSX.IntrinsicElements
}

export function GradientText({ children, className, as: Tag = 'span' }: GradientTextProps) {
  return (
    <Tag
      className={cn('text-gradient', className)}
    >
      {children}
    </Tag>
  )
}
