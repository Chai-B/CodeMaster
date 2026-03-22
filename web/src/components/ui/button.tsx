"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost";
  size?: "sm" | "md" | "lg";
  asChild?: boolean;
  href?: string;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "md", href, children, ...props }, ref) => {
    const base =
      "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7DA0C7] focus-visible:ring-offset-2 focus-visible:ring-offset-[#080808] disabled:pointer-events-none disabled:opacity-50 cursor-pointer select-none";

    const variants = {
      default:
        "bg-[#7DA0C7] text-[#080808] hover:bg-[#9CB8D5] active:scale-[0.98] shadow-lg shadow-[rgba(125,160,199,0.2)]",
      outline:
        "border border-[rgba(255,255,255,0.12)] bg-transparent text-[#F5F5F5] hover:bg-[rgba(255,255,255,0.05)] hover:border-[rgba(255,255,255,0.2)] active:scale-[0.98]",
      ghost:
        "bg-transparent text-[#6B7280] hover:text-[#F5F5F5] hover:bg-[rgba(255,255,255,0.04)] active:scale-[0.98]",
    };

    const sizes = {
      sm: "h-8 px-3 text-sm",
      md: "h-10 px-4 text-sm",
      lg: "h-12 px-6 text-base",
    };

    const classes = cn(base, variants[variant], sizes[size], className);

    if (href) {
      return (
        <a href={href} className={classes}>
          {children}
        </a>
      );
    }

    return (
      <button ref={ref} className={classes} {...props}>
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";

export { Button };
