import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
  {
    variants: {
      variant: {
        default: "bg-[color:var(--color-surface-muted)] text-[color:var(--color-text-muted)] ring-[color:var(--color-border-strong)]",
        success: "bg-[color:var(--color-success-muted)] text-[color:var(--color-success)] ring-[color:var(--color-success)]/20",
        warning: "bg-[color:var(--color-warning-muted)] text-[color:var(--color-warning)] ring-[color:var(--color-warning)]/20",
        danger:  "bg-[color:var(--color-danger-muted)]  text-[color:var(--color-danger)]  ring-[color:var(--color-danger)]/20",
        info:    "bg-[color:var(--color-info-muted)]    text-[color:var(--color-info)]    ring-[color:var(--color-info)]/20",
        brand:   "bg-[color:var(--color-brand-muted)]   text-[color:var(--color-brand)]   ring-[color:var(--color-brand)]/20",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
