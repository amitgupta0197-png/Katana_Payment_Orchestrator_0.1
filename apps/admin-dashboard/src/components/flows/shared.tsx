"use client";

// Shared pieces of the flow dashboards (/flows/*): the data hook (one GET per page, refreshed
// every 30 seconds), the Test / Live and banker filter bar, tone badges, a plain table, CSV
// download and IST formatting. Read-only: every action is a link to the screen that does it.

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink, RefreshCw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { pctText, rateTone, toCsv, type Tone } from "@/lib/flow-dashboards";

export const REFRESH_MS = 30_000;

/** ?mode= and ?banker= from the URL, and setters that keep the rest of the query. */
export function useFlowParams() {
  const sp = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const mode = sp.get("mode") === "test" ? "test" : sp.get("mode") === "live" ? "live" : null;
  const banker = sp.get("banker");
  const set = React.useCallback((k: string, v: string | null) => {
    const next = new URLSearchParams(sp.toString());
    if (v) next.set(k, v); else next.delete(k);
    const q = next.toString();
    router.replace(q ? `${path}?${q}` : path, { scroll: false });
  }, [sp, router, path]);
  return { mode, banker, setMode: (m: "live" | "test") => set("mode", m), setBanker: (b: string | null) => set("banker", b) };
}

export function useFlowData<T>(flow: "intent" | "p2p" | "payout" | "health", mode: string | null, banker: string | null) {
  return useQuery({
    queryKey: ["flows", flow, mode ?? "", banker ?? ""],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (mode) qs.set("mode", mode);
      if (banker) qs.set("banker", banker);
      const r = await fetch(`/api/flows/${flow}?${qs}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d as { error?: string }).error ?? `HTTP ${r.status}`);
      return d as T;
    },
    refetchInterval: REFRESH_MS,
  });
}

/** The page's own filter bar: Test / Live, the banker it is narrowed to, last refresh. */
export function FlowToolbar({ livemode, banker, asOf, fetching, onMode, onClearBanker, links }: {
  livemode: boolean | undefined; banker: string | null; asOf?: string; fetching?: boolean;
  onMode: (m: "live" | "test") => void; onClearBanker: () => void; links?: { href: string; label: string }[];
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
      <div role="radiogroup" aria-label="Data mode" className="inline-flex items-center rounded-full border bg-[color:var(--color-surface-muted)] p-0.5 font-semibold">
        {(["live", "test"] as const).map((m) => {
          const active = livemode === undefined ? false : (m === "live") === livemode;
          return (
            <button key={m} type="button" role="radio" aria-checked={active} onClick={() => onMode(m)}
              className={cn("rounded-full px-2.5 py-1", active && (m === "live"
                ? "bg-[color:var(--color-surface)] shadow-sm"
                : "bg-[color:var(--color-testmode)] text-[color:var(--color-testmode-fg)] shadow-sm"))}>
              {m === "live" ? "Live" : "Test"}
            </button>
          );
        })}
      </div>
      {banker && (
        <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1">
          Banker <span className="font-mono font-medium">{banker}</span>
          <button type="button" aria-label="Show all bankers" onClick={onClearBanker} className="ml-0.5 rounded-full hover:text-[color:var(--color-danger)]"><X className="h-3 w-3" /></button>
        </span>
      )}
      <span className="inline-flex items-center gap-1 text-[color:var(--color-text-muted)]">
        <RefreshCw className={cn("h-3 w-3", fetching && "animate-spin")} />
        {asOf ? `Updated ${istTime(asOf)} IST · every 30 s` : "Loading…"}
      </span>
      <span className="flex-1" />
      {links?.map((l) => (
        <Link key={l.href} href={l.href} className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 hover:border-[color:var(--color-brand)]">
          {l.label} <ExternalLink className="h-3 w-3" />
        </Link>
      ))}
    </div>
  );
}

const TONE_VARIANT: Record<Tone, "success" | "warning" | "danger" | "default"> = { good: "success", warn: "warning", bad: "danger", none: "default" };
export const TONE_COLOR: Record<Tone, string> = { good: "var(--color-success)", warn: "var(--color-warning)", bad: "var(--color-danger)", none: "var(--color-text-muted)" };

/** A success rate as a badge: green at 85% and over, amber from 60%, red under. */
export function RateBadge({ rate }: { rate: number | null | undefined }) {
  return <Badge variant={TONE_VARIANT[rateTone(rate)]}>{pctText(rate)}</Badge>;
}

export function StateBadge({ state }: { state: string }) {
  const v = state === "LIVE" ? "success" : state === "BLOCKED" || state === "SUSPENDED" ? "danger" : state === "ONBOARDING" ? "info" : "default";
  return <Badge variant={v}>{state === "UNKNOWN" ? "Not found" : state.charAt(0) + state.slice(1).toLowerCase()}</Badge>;
}

export function Section({ title, description, children, className, action }: {
  title: string; description?: string; children: React.ReactNode; className?: string; action?: React.ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-3">
        <div><CardTitle className="text-base">{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}</div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export interface Col<T> { header: string; cell: (r: T) => React.ReactNode; right?: boolean; title?: string }

export function SimpleTable<T>({ rows, cols, rowKey, empty }: { rows: T[]; cols: Col<T>[]; rowKey: (r: T) => string; empty: string }) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-left text-sm">
        <thead className="bg-[color:var(--color-surface-muted)] text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">
          <tr>{cols.map((c) => <th key={c.header} title={c.title} className={cn("whitespace-nowrap px-3 py-2 font-medium", c.right && "text-right")}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className="border-t border-[color:var(--color-border)]">
              {cols.map((c) => <td key={c.header} className={cn("px-3 py-2", c.right && "text-right tabular-nums")}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Builds the CSV in the browser and saves it. */
export function CsvButton({ filename, headers, rows, disabled }: { filename: string; headers: string[]; rows: (string | number | null | undefined)[][]; disabled?: boolean }) {
  const save = () => {
    const blob = new Blob([toCsv(headers, rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <button type="button" onClick={save} disabled={disabled || !rows.length}
      className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs hover:border-[color:var(--color-brand)] disabled:opacity-50">
      <Download className="h-3 w-3" /> Download CSV
    </button>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  return error ? <p className="mb-4 text-sm text-[color:var(--color-danger)]">{(error as Error).message}</p> : null;
}

/** A banker's name, linking to its staff page when we know its id. */
export function BankerLink({ id, name, code }: { id: string | null; name: string; code: string }) {
  const body = <><span className="font-medium">{name}</span>{name !== code && <span className="ml-1 font-mono text-xs text-[color:var(--color-text-muted)]">{code}</span>}</>;
  return id ? <Link href={`/bankers/${id}`} className="hover:underline">{body}</Link> : body;
}

const IST = "Asia/Kolkata";
export const istTime = (v: string) => new Date(v).toLocaleTimeString("en-IN", { timeZone: IST, hour: "2-digit", minute: "2-digit", hour12: false });
export const istDateTime = (v: string | null | undefined) => (v ? new Date(v).toLocaleString("en-IN", { timeZone: IST, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "—");
export const inr = (v: number | null | undefined) => (v == null ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(v));
export const mins = (v: number | null | undefined) => (v == null ? "—" : v < 1 ? `${Math.round(v * 60)} s` : v < 120 ? `${Math.round(v * 10) / 10} min` : `${Math.round(v / 6) / 10} h`);
export const ago = (v: string | null | undefined) => {
  if (!v) return "—";
  const m = Math.round((Date.now() - new Date(v).getTime()) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
