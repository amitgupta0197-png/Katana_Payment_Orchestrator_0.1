"use client";

// Dashboard alert strip. Shows urgent / blocking items the persona must
// attend to before doing anything else. Each row carries a CTA so the user
// can act on it without leaving the dashboard.

import * as React from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, AlertOctagon, Clock, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type AlertLevel = "critical" | "warning" | "info";

export interface AlertItem {
  level: AlertLevel;
  title: string;
  detail?: string;
  href?: string;
  cta?: string;
  icon?: LucideIcon;
}

const LEVEL: Record<AlertLevel, { iconClass: string; chip: string; defaultIcon: LucideIcon }> = {
  critical: { iconClass: "text-[color:var(--color-danger)]", chip: "bg-[color:var(--color-danger-muted)] text-[color:var(--color-danger)]", defaultIcon: AlertOctagon },
  warning:  { iconClass: "text-[color:var(--color-warning)]", chip: "bg-[color:var(--color-warning-muted)] text-[color:var(--color-warning)]", defaultIcon: AlertTriangle },
  info:     { iconClass: "text-[color:var(--color-info)]", chip: "bg-[color:var(--color-info-muted)] text-[color:var(--color-info)]", defaultIcon: Clock },
};

export function AlertStrip({ items }: { items: AlertItem[] }) {
  if (!items.length) return null;
  return (
    <Card className="divide-y divide-[color:var(--color-border)] overflow-hidden">
      {items.map((it, i) => {
        const meta = LEVEL[it.level];
        const Icon = it.icon ?? meta.defaultIcon;
        const inner = (
          <div className="flex items-center gap-3 px-4 py-2.5">
            <span className={cn("flex h-7 w-7 items-center justify-center rounded-md", meta.chip)}>
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium leading-tight truncate">{it.title}</div>
              {it.detail && <div className="text-xs text-[color:var(--color-text-muted)] truncate">{it.detail}</div>}
            </div>
            {it.href && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-[color:var(--color-brand)]">
                {it.cta ?? "Open"} <ChevronRight className="h-3.5 w-3.5" />
              </span>
            )}
          </div>
        );
        return it.href
          ? <Link key={i} href={it.href} className="block hover:bg-[color:var(--color-surface-muted)]">{inner}</Link>
          : <div key={i}>{inner}</div>;
      })}
    </Card>
  );
}
