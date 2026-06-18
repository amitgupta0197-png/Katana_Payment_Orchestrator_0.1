"use client";

// Dashboard KPI tile — label, value, optional trend indicator + sublabel.
// Used by all 3 persona dashboards to keep the L0 visual language identical.

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface KpiTileProps {
  label: string;
  value: React.ReactNode;
  sublabel?: string;
  icon?: LucideIcon;
  /** Positive number = up, negative = down, 0 = flat. */
  trend?: number;
  trendLabel?: string;
  /** When set, the tile becomes a link to this href. */
  href?: string;
  loading?: boolean;
  variant?: "default" | "warning" | "danger" | "success";
  className?: string;
}

const VARIANT: Record<NonNullable<KpiTileProps["variant"]>, string> = {
  default: "",
  warning: "border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning-muted)]/40",
  danger:  "border-[color:var(--color-danger)]/40 bg-[color:var(--color-danger-muted)]/40",
  success: "border-[color:var(--color-success)]/40 bg-[color:var(--color-success-muted)]/40",
};

export function KpiTile({
  label, value, sublabel, icon: Icon, trend, trendLabel, href, loading,
  variant = "default", className,
}: KpiTileProps) {
  const TrendIcon = trend === undefined ? null : trend > 0 ? ArrowUpRight : trend < 0 ? ArrowDownRight : Minus;
  const trendClass = trend === undefined ? "" : trend > 0 ? "text-[color:var(--color-success)]" : trend < 0 ? "text-[color:var(--color-danger)]" : "text-[color:var(--color-text-muted)]";

  const body = (
    <Card className={cn("flex flex-col gap-1 p-4 transition-shadow hover:shadow-sm", VARIANT[variant], href && "cursor-pointer", className)}>
      <div className="flex items-center justify-between gap-2 text-xs text-[color:var(--color-text-muted)]">
        <span className="truncate uppercase tracking-wide">{label}</span>
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
      </div>
      <div className="text-2xl font-semibold tabular-nums leading-tight">
        {loading ? <span className="inline-block h-7 w-20 animate-pulse rounded bg-[color:var(--color-surface-muted)]" /> : value}
      </div>
      {(trend !== undefined || sublabel) && (
        <div className="flex items-center gap-1.5 text-xs">
          {TrendIcon && <TrendIcon className={cn("h-3 w-3", trendClass)} />}
          {trend !== undefined && (
            <span className={cn("font-medium tabular-nums", trendClass)}>
              {trend > 0 ? "+" : ""}{trend.toFixed(1)}%
            </span>
          )}
          {trendLabel && <span className="text-[color:var(--color-text-muted)]">{trendLabel}</span>}
          {sublabel && <span className="text-[color:var(--color-text-muted)]">{sublabel}</span>}
        </div>
      )}
    </Card>
  );

  return href ? <Link href={href} className="block">{body}</Link> : body;
}
