"use client";

// Merchant dashboard infographics — dependency-free themed SVG charts computed
// client-side from the merchant's own orders (checkout + Katana Pay pay-ins):
//   - Pay-ins over the last 14 days (area + success line)
//   - Status breakdown (donut)

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAmount } from "@/lib/utils";

interface OrderLike { amount: number; status: string; created_at: string; method?: string }
export interface Day { label: string; total: number; success: number; failed: number; gross: number }

const isSuccess = (s: string) => s === "SUCCESS" || s === "SUCCEEDED";
const isFailed = (s: string) => s === "FAILED" || s === "EXPIRED" || s === "CANCELLED";

function buildSeries(orders: OrderLike[], days = 14): Day[] {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const buckets: Day[] = [];
  const index = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = d.toDateString();
    index.set(key, buckets.length);
    buckets.push({ label: `${d.getDate()}/${d.getMonth() + 1}`, total: 0, success: 0, failed: 0, gross: 0 });
  }
  for (const o of orders) {
    const k = new Date(o.created_at); k.setHours(0, 0, 0, 0);
    const idx = index.get(k.toDateString());
    if (idx === undefined) continue;
    const b = buckets[idx];
    b.total += 1;
    if (isSuccess(o.status)) { b.success += 1; b.gross += Number(o.amount || 0); }
    else if (isFailed(o.status)) b.failed += 1;
  }
  return buckets;
}

export function MerchantCharts({ orders, loading }: { orders: OrderLike[]; loading?: boolean }) {
  const series = buildSeries(orders);
  const status = orders.reduce(
    (acc, o) => {
      if (isSuccess(o.status)) acc.success += 1;
      else if (isFailed(o.status)) acc.failed += 1;
      else acc.pending += 1;
      return acc;
    },
    { success: 0, pending: 0, failed: 0 },
  );
  const grossTotal = series.reduce((s, d) => s + d.gross, 0);

  return (
    <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Pay-ins · last 14 days</CardTitle>
          <CardDescription>Daily order count. Dashed line = successful · {formatAmount(grossTotal)} collected.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <ChartSkeleton h={190} /> : <AreaChart series={series} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status breakdown</CardTitle>
          <CardDescription>Across all your orders.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <ChartSkeleton h={140} /> : <StatusDonut status={status} />}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Collected ₹ · last 14 days</CardTitle>
          <CardDescription>Successful pay-in value per day.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <ChartSkeleton h={170} /> : <GrossBars series={series} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Method mix</CardTitle>
          <CardDescription>Orders by payment method.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <ChartSkeleton h={140} /> : <MethodMix orders={orders} />}
        </CardContent>
      </Card>
    </div>
  );
}

export function GrossBars({ series }: { series: Day[] }) {
  const max = Math.max(1, ...series.map((s) => s.gross));
  return (
    <div className="flex h-[150px] items-end gap-1">
      {series.map((d, i) => (
        <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${d.label}: ${formatAmount(d.gross)}`}>
          <div className="flex w-full items-end" style={{ height: 120 }}>
            <div
              className="w-full rounded-t-sm transition-all"
              style={{ height: `${Math.max(2, (d.gross / max) * 100)}%`, background: "var(--color-brand)", opacity: d.gross === 0 ? 0.2 : 1 }}
            />
          </div>
          {(i === 0 || i === Math.floor(series.length / 2) || i === series.length - 1) && (
            <span className="text-[9px] text-[color:var(--color-text-muted)]">{d.label}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function MethodMix({ orders }: { orders: OrderLike[] }) {
  const map = new Map<string, { count: number; gross: number }>();
  for (const o of orders) {
    const key = o.method || "—";
    const cur = map.get(key) ?? { count: 0, gross: 0 };
    cur.count += 1;
    if (isSuccess(o.status)) cur.gross += Number(o.amount || 0);
    map.set(key, cur);
  }
  const rows = [...map.entries()].sort((a, b) => b[1].count - a[1].count);
  const max = Math.max(1, ...rows.map(([, v]) => v.count));

  if (!rows.length) return <div className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">No orders yet.</div>;

  return (
    <ul className="space-y-3">
      {rows.map(([method, v]) => (
        <li key={method}>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="font-medium">{method}</span>
            <span className="tabular-nums text-[color:var(--color-text-muted)]">{v.count} · {formatAmount(v.gross)}</span>
          </div>
          <div className="h-2 w-full rounded-full bg-[color:var(--color-surface-muted)]">
            <div className="h-2 rounded-full bg-[color:var(--color-brand)]" style={{ width: `${Math.max(4, (v.count / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ChartSkeleton({ h }: { h: number }) {
  return <div className="w-full animate-pulse rounded-xl bg-[color:var(--color-surface-muted)]" style={{ height: h }} />;
}

// Generic horizontal-bar list — used for channel/method/merchant mixes.
export function HBars({ rows, empty = "No data yet." }: { rows: { label: string; count: number; gross: number }[]; empty?: string }) {
  const sorted = [...rows].sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...sorted.map((r) => r.count));
  if (!sorted.length) return <div className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">{empty}</div>;
  return (
    <ul className="space-y-3">
      {sorted.map((r) => (
        <li key={r.label}>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="font-medium">{r.label}</span>
            <span className="tabular-nums text-[color:var(--color-text-muted)]">{r.count} · {formatAmount(r.gross)}</span>
          </div>
          <div className="h-2 w-full rounded-full bg-[color:var(--color-surface-muted)]">
            <div className="h-2 rounded-full bg-[color:var(--color-brand)]" style={{ width: `${Math.max(4, (r.count / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function AreaChart({ series }: { series: Day[] }) {
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
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} role="img" aria-label="Pay-ins over time">
      <defs>
        <linearGradient id="mpAreaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-brand)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--color-brand)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 0.5, 1].map((g) => (
        <line key={g} x1={pl} x2={W - pr} y1={pt + innerH * g} y2={pt + innerH * g}
          stroke="var(--color-border)" strokeWidth="1" strokeDasharray="3 4" opacity="0.5" />
      ))}
      <path d={area} fill="url(#mpAreaFill)" />
      <polyline points={totalLine} fill="none" stroke="var(--color-brand)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      <polyline points={successLine} fill="none" stroke="var(--color-success)" strokeWidth="2" strokeDasharray="2 3" opacity="0.9" />
      {max > 0 && peak && (
        <>
          <circle cx={x(series.indexOf(peak))} cy={y(peak.total)} r="3.5" fill="var(--color-brand)" />
          <text x={x(series.indexOf(peak))} y={y(peak.total) - 8} textAnchor="middle" fontSize="11" fill="var(--color-text)">{peak.total}</text>
        </>
      )}
      {[0, Math.floor(n / 2), n - 1].map((i) => (
        <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--color-text-muted)">{series[i]?.label}</text>
      ))}
    </svg>
  );
}

export function StatusDonut({ status }: { status: { success: number; pending: number; failed: number } }) {
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
      <svg viewBox="0 0 140 140" width="140" height="140" role="img" aria-label="Status breakdown">
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
