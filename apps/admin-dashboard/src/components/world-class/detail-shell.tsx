"use client";

// L3 detail shell — breadcrumb, hero, tabs, sticky right action panel.
// Every business module's [id]/page composes this:
//   <DetailShell title=... breadcrumbs=... tabs=[...] actions={...} />

import * as React from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ChevronRight, ChevronLeft } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface DetailTab {
  key: string;
  label: string;
  icon?: LucideIcon;
  count?: number | string;
  content: React.ReactNode;
  /** Hide tab entirely (e.g., persona doesn't have access) */
  hidden?: boolean;
}

export interface DetailAction {
  label: string;
  icon?: LucideIcon;
  onClick?: () => void;
  href?: string;
  variant?: "default" | "secondary" | "danger";
  disabled?: boolean;
  loading?: boolean;
  hidden?: boolean;
}

interface Crumb { label: string; href?: string }

interface DetailShellProps {
  breadcrumbs: Crumb[];
  title: string;
  subtitle?: string;
  status?: { label: string; variant?: "default" | "success" | "warning" | "danger" | "info" | "brand" };
  meta?: React.ReactNode;        // small KPI strip under title
  primaryActions?: DetailAction[]; // shown at top
  sideActions?: DetailAction[];   // sticky right rail
  dangerZone?: React.ReactNode;
  tabs: DetailTab[];
  defaultTab?: string;
  backHref?: string;
}

export function DetailShell({
  breadcrumbs, title, subtitle, status, meta,
  primaryActions = [], sideActions = [],
  tabs, defaultTab, backHref,
}: DetailShellProps) {
  const visibleTabs = tabs.filter((t) => !t.hidden);
  const initial = defaultTab ?? visibleTabs[0]?.key ?? "overview";

  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumb + back */}
      <div className="flex items-center gap-2 text-sm text-[color:var(--color-text-muted)]">
        {backHref && (
          <Link href={backHref} className="inline-flex items-center gap-1 hover:text-[color:var(--color-text)]">
            <ChevronLeft className="h-3.5 w-3.5" /> Back
          </Link>
        )}
        {breadcrumbs.map((c, i) => (
          <React.Fragment key={`${c.label}-${i}`}>
            {(i > 0 || backHref) && <ChevronRight className="h-3 w-3 text-[color:var(--color-text-subtle)]" />}
            {c.href ? (
              <Link href={c.href} className="hover:text-[color:var(--color-text)]">{c.label}</Link>
            ) : (
              <span className="text-[color:var(--color-text)]">{c.label}</span>
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Hero */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight truncate">{title}</h1>
            {status && <Badge variant={status.variant ?? "default"}>{status.label}</Badge>}
          </div>
          {subtitle && (
            <p className="mt-1 text-sm text-[color:var(--color-text-muted)]">{subtitle}</p>
          )}
          {meta && <div className="mt-3">{meta}</div>}
        </div>
        {primaryActions.filter((a) => !a.hidden).length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {primaryActions.filter((a) => !a.hidden).map((a, i) => {
              const Icon = a.icon;
              const variant = a.variant === "danger" ? "danger" : a.variant === "secondary" ? "secondary" : "default";
              if (a.href) {
                return (
                  <Button key={i} variant={variant} asChild disabled={a.disabled}>
                    <Link href={a.href}>{Icon ? <Icon className="h-4 w-4" /> : null} {a.label}</Link>
                  </Button>
                );
              }
              return (
                <Button key={i} variant={variant} onClick={a.onClick} disabled={a.disabled || a.loading}>
                  {Icon ? <Icon className="h-4 w-4" /> : null}
                  {a.loading ? "Working…" : a.label}
                </Button>
              );
            })}
          </div>
        )}
      </div>

      {/* Body: tabs (left) + sticky side rail */}
      <div className={cn("flex flex-col gap-6", sideActions.length > 0 && "lg:grid lg:grid-cols-[1fr_18rem]")}>
        <Tabs defaultValue={initial} className="min-w-0">
          <TabsList className="flex-wrap">
            {visibleTabs.map((t) => {
              const Icon = t.icon;
              return (
                <TabsTrigger key={t.key} value={t.key}>
                  {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
                  {t.label}
                  {t.count !== undefined && (
                    <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs font-normal">
                      {t.count}
                    </span>
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {visibleTabs.map((t) => (
            <TabsContent key={t.key} value={t.key}>{t.content}</TabsContent>
          ))}
        </Tabs>
        {sideActions.length > 0 && (
          <aside className="lg:sticky lg:top-6 lg:self-start">
            <div className="flex flex-col gap-2 rounded-lg border bg-[color:var(--color-surface)] p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
                Quick actions
              </div>
              {sideActions.filter((a) => !a.hidden).map((a, i) => {
                const Icon = a.icon;
                const variant = a.variant === "danger" ? "danger" : a.variant === "default" ? "default" : "secondary";
                if (a.href) {
                  return (
                    <Button key={i} variant={variant} asChild disabled={a.disabled}>
                      <Link href={a.href}>{Icon ? <Icon className="h-4 w-4" /> : null} {a.label}</Link>
                    </Button>
                  );
                }
                return (
                  <Button key={i} variant={variant} onClick={a.onClick} disabled={a.disabled || a.loading}>
                    {Icon ? <Icon className="h-4 w-4" /> : null}
                    {a.loading ? "Working…" : a.label}
                  </Button>
                );
              })}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
