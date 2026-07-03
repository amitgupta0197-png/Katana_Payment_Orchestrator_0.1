"use client";

// Dashboard infographics — dependency-free, themed SVG charts:
//   - Transactions over 14 days (area + success line)
//   - Order status breakdown (donut)
//   - Onboarding funnel by stage (bars)
// Driven by /api/admin/charts.

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Day { day: string; label: string; total: number; success: number; failed: number; gross: number }
interface ChartData {
  txn_series: Day[];
  status: { success: number; pending: number; failed: number };
  funnel: { stage: string; n: number }[];
}

const STAGE_ORDER = ["APPLICATION", "DOCS_PENDING", "SCREENING", "BANK_VERIFY", "CONFIG", "LIVE"];

export function DashboardCharts() {
  const q = useQuery({
    queryKey: ["admin:charts"],
    queryFn: async () => (await fetch("/api/admin/charts").then((r) => r.json())) as ChartData,
    refetchInterval: 60_000,
  });
  const d = q.data;

  return (
    <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Transactions · last 14 days</CardTitle>
          <CardDescription>Daily volume (checkout + Katana Pay pay-ins). Line = successful.</CardDescription>
        </CardHeader>
        <CardContent>
          {d ? <AreaChart series={d.txn_series} /> : <ChartSkeleton h={180} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Order status</CardTitle>
          <CardDescription>Across all orders.</CardDescription>
        </CardHeader>
        <CardContent>
          {d ? <StatusDonut status={d.status} /> : <ChartSkeleton h={180} />}
        </CardContent>
      </Card>

      <Card className="lg:col-span-3">
        <CardHeader>
          <CardTitle className="text-base">Branch onboarding funnel</CardTitle>
          <CardDescription>Branches by stage.</CardDescription>
        </CardHeader>
        <CardContent>
          {d ? <FunnelBars funnel={d.funnel} /> : <ChartSkeleton h={140} />}
        </CardContent>
      </Card>
    </div>
  );
}

function ChartSkeleton({ h }: { h: number }) {
  return <div className="w-full animate-pulse rounded-xl bg-[color:var(--color-surface-muted)]" style={{ height: h }} />;
}

function AreaChart({ series }: { series: Day[] }) {
  const W = 600, H = 190, pl = 6, pr = 6, pt = 14, pb = 26;
  const innerW = W - pl - pr, innerH = H - pt - pb;
  const n = series.length;
  const max = Math.max(1, ...series.map((s) => s.total));
  const x = (i: number) => pl + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => pt + innerH - (v / max) * innerH;
  const base = pt + innerH;

  const totalLine = series.map((s, i) => `${x(i)},${y(s.total)}`).join(" ");
  const area = `M ${x(0)},${base} ` + series.map((s, i) => `L ${x(i)},${y(s.total)}`).join(" ") + ` L ${x(n - 1)},${base} Z`;
  const successLine = series.map((s, i) => `${x(i)},${y(s.success)}`).join(" ");
  const peak = series.reduce((m, s) => (s.total > m.total ? s : m), series[0]);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} role="img" aria-label="Transactions over time">
      <defs>
        <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-brand)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--color-brand)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* gridlines */}
      {[0, 0.5, 1].map((g) => (
        <line key={g} x1={pl} x2={W - pr} y1={pt + innerH * g} y2={pt + innerH * g}
          stroke="var(--color-border)" strokeWidth="1" strokeDasharray="3 4" opacity="0.5" />
      ))}
      <path d={area} fill="url(#areaFill)" />
      <polyline points={totalLine} fill="none" stroke="var(--color-brand)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      <polyline points={successLine} fill="none" stroke="var(--color-success)" strokeWidth="2" strokeDasharray="2 3" opacity="0.9" />
      {/* peak marker */}
      {max > 0 && peak && (
        <>
          <circle cx={x(series.indexOf(peak))} cy={y(peak.total)} r="3.5" fill="var(--color-brand)" />
          <text x={x(series.indexOf(peak))} y={y(peak.total) - 8} textAnchor="middle" fontSize="11" fill="var(--color-text)">{peak.total}</text>
        </>
      )}
      {/* x labels: first, middle, last */}
      {[0, Math.floor(n / 2), n - 1].map((i) => (
        <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--color-text-muted)">{series[i]?.label}</text>
      ))}
    </svg>
  );
}

function StatusDonut({ status }: { status: { success: number; pending: number; failed: number } }) {
  const segs = [
    { label: "Success", v: status.success, color: "var(--color-success)" },
    { label: "Pending", v: status.pending, color: "var(--color-warning)" },
    { label: "Failed", v: status.failed, color: "var(--color-danger)" },
  ];
  const total = segs.reduce((a, s) => a + s.v, 0);
  const R = 52, C = 2 * Math.PI * R, cx = 70, cy = 70, sw = 16;
  let acc = 0;

  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 140 140" width="140" height="140" role="img" aria-label="Order status breakdown">
        <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--color-surface-muted)" strokeWidth={sw} />
        {total > 0 && segs.map((s) => {
          const frac = s.v / total;
          const el = (
            <circle key={s.label} cx={cx} cy={cy} r={R} fill="none" stroke={s.color} strokeWidth={sw}
              strokeDasharray={`${frac * C} ${C}`} strokeDashoffset={-acc * C}
              transform={`rotate(-90 ${cx} ${cy})`} strokeLinecap="butt" />
          );
          acc += frac;
          return el;
        })}
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize="22" fontWeight="700" fill="var(--color-text)">{total}</text>
        <text x={cx} y={cy + 16} textAnchor="middle" fontSize="10" fill="var(--color-text-muted)">orders</text>
      </svg>
      <ul className="space-y-1.5 text-sm">
        {segs.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
            <span className="text-[color:var(--color-text-muted)]">{s.label}</span>
            <span className="font-medium tabular-nums">{s.v}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FunnelBars({ funnel }: { funnel: { stage: string; n: number }[] }) {
  const map = new Map(funnel.map((f) => [f.stage, f.n]));
  const data = STAGE_ORDER.map((stage) => ({ stage, n: map.get(stage) ?? 0 }));
  // include any non-canonical stages too
  for (const f of funnel) if (!STAGE_ORDER.includes(f.stage)) data.push({ stage: f.stage, n: f.n });
  const max = Math.max(1, ...data.map((d) => d.n));

  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
      {data.map((d) => {
        const isLive = d.stage === "LIVE";
        return (
          <div key={d.stage} className="flex flex-col items-center justify-end gap-1.5">
            <div className="text-sm font-semibold tabular-nums">{d.n}</div>
            <div className="flex h-24 w-full items-end">
              <div
                className="w-full rounded-t-md transition-all"
                style={{
                  height: `${Math.max(4, (d.n / max) * 100)}%`,
                  background: isLive ? "var(--color-success)" : "var(--color-brand)",
                  opacity: d.n === 0 ? 0.25 : 1,
                }}
              />
            </div>
            <div className="text-center text-[10px] uppercase tracking-wide text-[color:var(--color-text-muted)]">{d.stage}</div>
          </div>
        );
      })}
    </div>
  );
}
