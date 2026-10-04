// Flow dashboards: the flow health monitor (/flows/health) — every banker × Intent, P2P and
// payout, each a tile coloured by tileTone (lib/flow-dashboards). STAFF ONLY, read-only.

import { rows } from "@/lib/pg";
import { successRate, tileReason, tileTone, type TileInput, type Tone } from "@/lib/flow-dashboards";
import { bankerDirectory, bankerState, ENDED_SQL, PAID_SQL } from "@/lib/flow-dashboards-store";
import { OPEN_SQL } from "@/lib/flow-dashboards-payout";

const n = (v: unknown) => (v == null ? 0 : Number(v) || 0);

export type Flow = "INTENT" | "P2P" | "PAYOUT";
export const FLOWS: readonly Flow[] = ["INTENT", "P2P", "PAYOUT"];

export interface Tile extends TileInput { tone: Tone; reason: string | null; success_24h: number | null }
export interface HealthRow {
  code: string; id: string | null; name: string; provider_name: string | null; state: ReturnType<typeof bankerState>;
  tiles: Record<Flow, Tile>;
}
export interface HealthGrid {
  livemode: boolean; as_of: string; rows: HealthRow[];
  alerts: { code: string; name: string; flow: Flow; reason: string }[];
  counts: Record<Tone, number>;
}

const empty = (): Tile => ({ orders_1h: 0, ended_1h: 0, failed_1h: 0, orders_24h: 0, queue: 0, tone: "none", reason: null, success_24h: null });

export async function healthGrid(livemode: boolean, banker: string | null = null): Promise<HealthGrid> {
  const pay = await Promise.all([
    rows<Record<string, string | null>>("vendorGateway", `
      SELECT merchant_id AS code, channel_type AS flow, COUNT(*)::text AS orders_24h,
             COUNT(*) FILTER (WHERE ${PAID_SQL})::text AS paid_24h, COUNT(*) FILTER (WHERE ${ENDED_SQL})::text AS ended_24h,
             COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')::text AS orders_1h,
             COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour' AND ${ENDED_SQL})::text AS ended_1h,
             COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour' AND status IN ('FAILED','EXPIRED'))::text AS failed_1h
        FROM vendor_payin_orders
       WHERE vendor = 'KATANA' AND livemode = $1 AND channel_type IN ('INTENT','P2P') AND merchant_id IS NOT NULL
         AND created_at > now() - interval '24 hours' ${banker ? "AND merchant_id = $2" : ""}
       GROUP BY 1, 2 LIMIT 2000`, banker ? [livemode, banker] : [livemode]),
    rows<Record<string, string | null>>("fifo", `
      SELECT merchant_id AS code,
             COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::text AS orders_24h,
             COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours' AND status IN ('COMPLETED','SETTLED'))::text AS paid_24h,
             COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours' AND NOT (${OPEN_SQL}))::text AS ended_24h,
             COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')::text AS orders_1h,
             COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour' AND NOT (${OPEN_SQL}))::text AS ended_1h,
             COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour' AND status IN ('FAILED','REJECTED','CANCELLED','REVERSED'))::text AS failed_1h,
             COUNT(*) FILTER (WHERE ${OPEN_SQL})::text AS queue
        FROM fifo_orders
       WHERE direction = 'PAYOUT' AND livemode = $1 AND merchant_id IS NOT NULL AND created_at > now() - interval '30 days'
         ${banker ? "AND merchant_id = $2" : ""}
       GROUP BY 1
      HAVING COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') > 0 OR COUNT(*) FILTER (WHERE ${OPEN_SQL}) > 0
       LIMIT 2000`, banker ? [livemode, banker] : [livemode]),
    bankerDirectory(),
  ]);
  const [payins, payouts, dir] = pay;

  const grid = new Map<string, Record<Flow, Tile>>();
  const slot = (code: string) => { let g = grid.get(code); if (!g) { g = { INTENT: empty(), P2P: empty(), PAYOUT: empty() }; grid.set(code, g); } return g; };
  const fill = (t: Tile, r: Record<string, string | null>, queue = 0) => {
    t.orders_24h = n(r.orders_24h); t.orders_1h = n(r.orders_1h); t.ended_1h = n(r.ended_1h); t.failed_1h = n(r.failed_1h); t.queue = queue;
    t.success_24h = successRate(n(r.paid_24h), n(r.ended_24h));
  };
  for (const r of payins) fill(slot(r.code!)[r.flow as Flow], r);
  for (const r of payouts) fill(slot(r.code!).PAYOUT, r, n(r.queue));

  const counts: Record<Tone, number> = { good: 0, warn: 0, bad: 0, none: 0 };
  const alerts: HealthGrid["alerts"] = [];
  const out: HealthRow[] = [];
  for (const [code, tiles] of grid) {
    const info = dir.get(code);
    for (const f of FLOWS) {
      const t = tiles[f];
      t.tone = tileTone(t); t.reason = tileReason(t);
      counts[t.tone]++;
      if (t.tone === "bad" && t.reason) alerts.push({ code, name: info?.name ?? code, flow: f, reason: t.reason });
    }
    out.push({ code, id: info?.id ?? null, name: info?.name ?? code, provider_name: info?.provider_name ?? null, state: bankerState(info), tiles });
  }
  const rank = (r: HealthRow) => Math.max(...FLOWS.map((f) => ({ bad: 3, warn: 2, good: 1, none: 0 })[r.tiles[f].tone]));
  out.sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
  return { livemode, as_of: new Date().toISOString(), rows: out, alerts, counts };
}
