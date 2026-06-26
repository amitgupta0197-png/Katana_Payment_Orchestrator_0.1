"use client";

// Dashboard KPI tile — premium stat card: accent-chipped icon, large value,
// optional trend + sublabel, subtle accent glow per variant, hover lift.
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

// Per-variant accent color token (drives the icon chip + value + glow).
const ACCENT: Record<NonNullable<KpiTileProps["variant"]>, string> = {
  default: "var(--color-brand)",
  warning: "var(--color-warning)",
  danger: "var(--color-danger)",
  success: "var(--color-success)",
};

export function KpiTile({
  label, value, sublabel, icon: Icon, trend, trendLabel, href, loading,
  variant = "default", className,
}: KpiTileProps) {
  const TrendIcon = trend === undefined ? null : trend > 0 ? ArrowUpRight : trend < 0 ? ArrowDownRight : Minus;
  const trendClass = trend === undefined ? "" : trend > 0 ? "text-[color:var(--color-success)]" : trend < 0 ? "text-[color:var(--color-danger)]" : "text-[color:var(--color-text-muted)]";
  const accent = ACCENT[variant];
  // Inline accent vars keep the per-variant color in one place and let us tint
  // the chip background, border, value, and glow consistently via color-mix.
  const accentStyle = { "--kpi-accent": accent } as React.CSSProperties;

  const body = (
    <Card
      style={accentStyle}
      className={cn(
        "lift group relative flex flex-col gap-3 overflow-hidden p-4",
        href && "cursor-pointer",
        className,
      )}
    >
      {/* corner accent glow */}
      <span
        aria-hidden
        className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full opacity-60 blur-2xl transition-opacity group-hover:opacity-90"
        style={{ background: "color-mix(in oklab, var(--kpi-accent) 35%, transparent)" }}
      />
      <div className="flex items-start justify-between gap-2">
        <span className="truncate pt-1 text-[11px] font-medium uppercase tracking-wider text-[color:var(--color-text-muted)]">
          {label}
        </span>
        {Icon && (
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{
              background: "color-mix(in oklab, var(--kpi-accent) 16%, transparent)",
              color: "var(--kpi-accent)",
              boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--kpi-accent) 30%, transparent)",
            }}
          >
            <Icon className="h-4 w-4" />
          </span>
        )}
      </div>
      <div
        className="text-3xl font-bold tabular-nums leading-none"
        style={variant === "default" ? undefined : { color: "var(--kpi-accent)" }}
      >
        {loading ? <span className="inline-block h-8 w-20 animate-pulse rounded bg-[color:var(--color-surface-muted)]" /> : value}
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
