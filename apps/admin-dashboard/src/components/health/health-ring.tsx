"use client";

// Actor health at a glance (lib/health): a small coloured ring with the score, and a badge for
// detail headers. BLOCKED is drawn distinctly (dashed red ring, no number) because its score is
// forced to 0. Clicking either opens the checklist (ChecklistDrawer). Staff screens only.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChecklistDrawer } from "@/components/health/checklist-drawer";

export type HealthBand = "GREEN" | "AMBER" | "RED" | "BLOCKED";
export type HealthActorType = "TSP" | "BANKER" | "MERCHANT" | "INTEGRATION";

export interface CachedHealthRow {
  actor_type: HealthActorType; actor_id: string; label: string | null; live: boolean;
  score: number; raw_score: number; band: HealthBand; computed_at: string; stale: boolean;
  items: { key: string; label: string; state: "DONE" | "MISSING" | "OPTIONAL_MISSING"; critical: boolean; action?: string; href?: string }[];
}

export const BAND_COLOR: Record<HealthBand, string> = {
  GREEN: "var(--color-success)", AMBER: "var(--color-warning)", RED: "var(--color-danger)", BLOCKED: "var(--color-danger)",
};
export const BAND_VARIANT: Record<HealthBand, "success" | "warning" | "danger"> = {
  GREEN: "success", AMBER: "warning", RED: "danger", BLOCKED: "danger",
};

/** Cached health for many actors in one call (GET /api/health-checks), keyed by actor id. */
export function useHealthScores(type: HealthActorType, ids: string[] | null, opts: { enabled?: boolean } = {}) {
  const key = ids ? [...ids].sort().join(",") : "*";
  return useQuery({
    queryKey: ["health-checks", type, key],
    enabled: opts.enabled !== false && (ids === null || ids.length > 0),
    staleTime: 60_000,
    queryFn: async () => {
      const qs = new URLSearchParams({ type });
      // Long id lists go as "all of this type": one cached read either way.
      if (ids && ids.length <= 300) qs.set("ids", ids.join(","));
      const r = await fetch(`/api/health-checks?${qs}`);
      // null = this login may not see health (staff only): the caller hides the column.
      if (r.status === 401 || r.status === 403) return null;
      if (!r.ok) return new Map<string, CachedHealthRow>();
      const d = (await r.json()) as { rows: CachedHealthRow[] };
      return new Map(d.rows.map((x) => [x.actor_id, x]));
    },
  });
}

interface RingProps {
  score: number | null | undefined;
  band: HealthBand | null | undefined;
  size?: number;
  className?: string;
  title?: string;
}

/** The ring alone. `band` null = not computed yet (grey). */
export function Ring({ score, band, size = 28, className, title }: RingProps) {
  const sw = Math.max(3, Math.round(size / 9));
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const blocked = band === "BLOCKED";
  const frac = band && !blocked ? Math.max(0, Math.min(100, score ?? 0)) / 100 : 0;
  const color = band ? BAND_COLOR[band] : "var(--color-border-strong)";
  return (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center", className)} style={{ width: size, height: size }}
      title={title ?? (band ? `${band}${blocked ? "" : ` · ${score}`}` : "Not computed yet")}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-surface-muted)" strokeWidth={sw} />
        {blocked ? (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={sw} strokeDasharray="3 2.5" />
        ) : band ? (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round"
            strokeDasharray={`${frac * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        ) : null}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-semibold tabular-nums"
        style={{ fontSize: Math.max(8, Math.round(size * 0.34)), color: band ? color : "var(--color-text-muted)" }}>
        {blocked ? <Ban style={{ width: size * 0.42, height: size * 0.42 }} /> : band ? score : "–"}
      </span>
    </span>
  );
}

interface ActorProps { type: HealthActorType; id: string; label?: string }

/** A ring for a list row: shows the cached score and opens the checklist on click. */
export function HealthRing({ type, id, label, row, size = 28 }: ActorProps & { row?: CachedHealthRow | null; size?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand)]"
        aria-label={`Health ${row?.band ?? "not computed"}${row && row.band !== "BLOCKED" ? ` ${row.score}` : ""}: open checklist`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}>
        <Ring score={row?.score} band={row?.band} size={size} />
      </button>
      {/* React events bubble out of the drawer's portal: keep them from the row's own click. */}
      {open && <span onClick={(e) => e.stopPropagation()}><ChecklistDrawer type={type} id={id} label={label ?? row?.label ?? id} open={open} onOpenChange={setOpen} /></span>}
    </>
  );
}

/** For detail headers: ring + band word; fetches its own (cached) row. */
export function HealthBadge({ type, id, label, className }: ActorProps & { className?: string }) {
  const q = useHealthScores(type, [id]);
  const row = q.data?.get(id) ?? null;
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className={cn("inline-flex items-center gap-2 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-surface)] py-0.5 pl-0.5 pr-2.5 text-xs hover:bg-[color:var(--color-surface-muted)]", className)}>
        <Ring score={row?.score} band={row?.band} size={22} />
        <span className="font-medium" style={{ color: row ? BAND_COLOR[row.band] : "var(--color-text-muted)" }}>
          {row ? (row.band === "BLOCKED" ? "Blocked" : `${row.band.charAt(0)}${row.band.slice(1).toLowerCase()} · ${row.score}`) : q.isLoading ? "Health…" : "Health"}
        </span>
      </button>
      {open && <ChecklistDrawer type={type} id={id} label={label ?? row?.label ?? id} open={open} onOpenChange={setOpen} />}
    </>
  );
}
