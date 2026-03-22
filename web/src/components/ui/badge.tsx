import * as React from "react";
import { cn } from "@/lib/utils";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "outline";
}

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  const variants = {
    default:
      "bg-[rgba(125,160,199,0.12)] text-[#7DA0C7] border border-[rgba(125,160,199,0.2)]",
    outline:
      "bg-transparent text-[#6B7280] border border-[rgba(255,255,255,0.1)]",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium font-mono",
        variants[variant],
        className
      )}
      {...props}
    />
  );
}

export { Badge };
