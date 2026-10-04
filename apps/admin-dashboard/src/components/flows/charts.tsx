"use client";

// Dependency-free SVG charts for the flow dashboards (no chart library in this app; the same
// approach as components/world-class/dashboard-charts). Every mark has a hover title, every
// chart with two or more series has a legend, and text uses text tokens, never a series colour.

import * as React from "react";

export interface Series { key: string; label: string; color: string }

const EMPTY = (msg: string) => <p className="py-10 text-center text-sm text-[color:var(--color-text-muted)]">{msg}</p>;

export function Legend({ series }: { series: Series[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[color:var(--color-text-muted)]">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</li>
      ))}
    </ul>
  );
}

/** A 0..1 rate over time, as a line with the 85% / 60% guides. Null points break the line. */
export function RateLine({ points, empty = "No ended orders in the last 24 hours yet." }: {
  points: { label: string; rate: number | null; detail: string }[]; empty?: string;
}) {
  const [hover, setHover] = React.useState<number | null>(null);
  if (!points.some((p) => p.rate != null)) return EMPTY(empty);
  const W = 640, H = 200, pl = 34, pr = 8, pt = 10, pb = 24;
  const iw = W - pl - pr, ih = H - pt - pb, nPts = points.length;
  const x = (i: number) => pl + (nPts <= 1 ? iw / 2 : (i / (nPts - 1)) * iw);
  const y = (r: number) => pt + ih - r * ih;
  const segs: string[] = [];
  let cur: string[] = [];
  points.forEach((p, i) => {
    if (p.rate == null) { if (cur.length) segs.push(cur.join(" ")); cur = []; return; }
    cur.push(`${x(i)},${y(p.rate)}`);
  });
  if (cur.length) segs.push(cur.join(" "));
  const h = hover != null ? points[hover] : null;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: H }} role="img" aria-label="Success rate by hour"
        onMouseLeave={() => setHover(null)}>
        {[0, 0.6, 0.85, 1].map((g) => (
          <g key={g}>
            <line x1={pl} x2={W - pr} y1={y(g)} y2={y(g)} stroke="var(--color-border)" strokeDasharray={g === 0 || g === 1 ? undefined : "3 4"} opacity={0.7} />
            <text x={pl - 4} y={y(g) + 3} textAnchor="end" fontSize="10" fill="var(--color-text-muted)">{Math.round(g * 100)}%</text>
          </g>
        ))}
        {segs.map((s, i) => <polyline key={i} points={s} fill="none" stroke="var(--color-brand)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />)}
        {points.map((p, i) => p.rate != null && (
          <circle key={i} cx={x(i)} cy={y(p.rate)} r={hover === i ? 4.5 : 3} fill="var(--color-brand)" stroke="var(--color-surface)" strokeWidth="2" />
        ))}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={pt} y2={pt + ih} stroke="var(--color-text-muted)" strokeWidth="1" opacity="0.5" />}
        {points.map((p, i) => (i % 3 === 0 || i === nPts - 1) && (
          <text key={i} x={x(i)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--color-text-muted)">{p.label}</text>
        ))}
        {points.map((_, i) => (
          <rect key={i} x={x(i) - iw / nPts / 2} y={pt} width={iw / nPts} height={ih} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {h && (
        <div className="pointer-events-none absolute right-2 top-0 rounded-md border bg-[color:var(--color-surface)] px-2 py-1 text-xs shadow-sm">
          <span className="font-medium">{h.label}</span> · {h.rate == null ? "nothing ended" : `${Math.round(h.rate * 1000) / 10}%`} · {h.detail}
        </div>
      )}
    </div>
  );
}

/** Vertical stacked bars: one bar per category, one segment per series. */
export function StackedBars({ data, series, format = (v) => String(v), empty, height = 180 }: {
  data: { label: string; values: Record<string, number>; href?: string }[]; series: Series[];
  format?: (v: number) => string; empty: string; height?: number;
}) {
  const totals = data.map((d) => series.reduce((s, x) => s + (d.values[x.key] ?? 0), 0));
  const max = Math.max(0, ...totals);
  if (!data.length || max <= 0) return EMPTY(empty);
  return (
    <div>
      <div className="flex items-end gap-1.5 overflow-x-auto" style={{ height }}>
        {data.map((d, i) => (
          <div key={d.label} className="flex min-w-[22px] flex-1 flex-col items-center justify-end gap-1" style={{ height: "100%" }}
            title={`${d.label}: ${series.map((s) => `${s.label} ${format(d.values[s.key] ?? 0)}`).join(", ")}`}>
            <div className="text-[10px] tabular-nums text-[color:var(--color-text-muted)]">{totals[i] ? format(totals[i]) : ""}</div>
            <div className="flex w-full flex-col-reverse gap-[2px]" style={{ height: `${(totals[i] / max) * 78}%` }}>
              {series.map((s) => {
                const v = d.values[s.key] ?? 0;
                return v > 0 ? <div key={s.key} className="w-full first:rounded-b-[2px] last:rounded-t-[4px]" style={{ flex: v, background: s.color, minHeight: 2 }} /> : null;
              })}
            </div>
            <div className="w-full truncate text-center text-[10px] text-[color:var(--color-text-muted)]">{d.label}</div>
          </div>
        ))}
      </div>
      {series.length > 1 && <Legend series={series} />}
    </div>
  );
}

/** A donut of parts of a whole, with a labelled legend (counts) beside it. */
export function Donut({ parts, unit, empty }: { parts: { label: string; n: number; color: string }[]; unit: string; empty: string }) {
  const total = parts.reduce((s, p) => s + p.n, 0);
  if (total <= 0) return EMPTY(empty);
  const R = 52, C = 2 * Math.PI * R, cx = 70, cy = 70;
  let acc = 0;
  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg viewBox="0 0 140 140" width="140" height="140" role="img" aria-label={`${unit} by reason`}>
        <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--color-surface-muted)" strokeWidth={16} />
        {parts.filter((p) => p.n > 0).map((p) => {
          const frac = p.n / total;
          const el = (
            <circle key={p.label} cx={cx} cy={cy} r={R} fill="none" stroke={p.color} strokeWidth={16}
              strokeDasharray={`${Math.max(0, frac * C - 2)} ${C}`} strokeDashoffset={-acc * C} transform={`rotate(-90 ${cx} ${cy})`}>
              <title>{`${p.label}: ${p.n}`}</title>
            </circle>
          );
          acc += frac;
          return el;
        })}
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize="22" fontWeight="700" fill="var(--color-text)">{total}</text>
        <text x={cx} y={cy + 16} textAnchor="middle" fontSize="10" fill="var(--color-text-muted)">{unit}</text>
      </svg>
      <ul className="space-y-1.5 text-sm">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />
            <span className="text-[color:var(--color-text-muted)]">{p.label}</span>
            <span className="font-medium tabular-nums">{p.n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Horizontal bars with a value at the end, for a handful of buckets. */
export function HBars({ items, empty }: { items: { label: string; n: number; color?: string }[]; empty: string }) {
  const max = Math.max(0, ...items.map((i) => i.n));
  if (max <= 0) return EMPTY(empty);
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i.label} className="grid grid-cols-[8rem_1fr_3rem] items-center gap-2 text-sm">
          <span className="truncate text-[color:var(--color-text-muted)]">{i.label}</span>
          <span className="h-3 rounded-r-[4px] bg-[color:var(--color-surface-muted)]">
            <span className="block h-3 rounded-r-[4px]" style={{ width: `${(i.n / max) * 100}%`, background: i.color ?? "var(--color-brand)", minWidth: i.n ? 3 : 0 }} />
          </span>
          <span className="text-right font-medium tabular-nums">{i.n}</span>
        </li>
      ))}
    </ul>
  );
}
