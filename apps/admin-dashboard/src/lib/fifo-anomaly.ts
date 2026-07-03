// Anomaly detection for the FIFO module (Katana BRD Phase 3 "AI anomaly alerts").
// A statistical scanner over recent orders that flags outliers the deterministic
// rules (velocity/duplicate-UTR) miss: amount outliers (per-merchant z-score),
// short-window volume spikes, and off-hours high-value activity. Findings are
// raised as ANOMALY fraud alerts, de-duplicated against existing open ones.

import { rows } from "@/lib/pg";
import { recordFraudAlert } from "@/lib/fifo";

const Z_THRESHOLD = 3;           // amount outlier: > mean + 3σ
const AMOUNT_FLOOR_MINOR = 1000_00; // ignore tiny amounts (₹1,000)
const SPIKE_WINDOW_MIN = 60, SPIKE_FACTOR = 4, SPIKE_MIN = 8; // 4× baseline & >=8 in window
const OFFHOURS_START = 0, OFFHOURS_END = 5; // local-ish off hours
const OFFHOURS_AMOUNT_MINOR = 5000_00;

export async function scanAnomalies(): Promise<{ scanned: number; raised: number; buckets: Record<string, number> }> {
  const buckets: Record<string, number> = { AMOUNT_OUTLIER: 0, VOLUME_SPIKE: 0, OFFHOURS_HIGH_VALUE: 0 };

  // Orders already carrying an OPEN anomaly alert — skip to avoid duplicates.
  const seen = new Set((await rows<{ order_id: string }>("fifo", `
    SELECT DISTINCT order_id::text FROM fifo_fraud_alerts WHERE alert_type='ANOMALY' AND status='OPEN'
  `).catch(() => [])).map((r) => r.order_id));

  // Per-merchant amount stats over the last 30 days.
  const stats = await rows<any>("fifo", `
    SELECT merchant_id, AVG(amount_minor)::float AS mean, COALESCE(STDDEV_POP(amount_minor),0)::float AS sd, COUNT(*)::int AS n
      FROM fifo_orders WHERE created_at > now() - interval '30 days' GROUP BY merchant_id
  `).catch(() => []);
  const statByMerchant = new Map(stats.map((s) => [s.merchant_id, s]));

  // Recent orders (last 24h) to evaluate.
  const recent = await rows<any>("fifo", `
    SELECT id::text, order_ref, merchant_id, amount_minor::text, created_at,
           EXTRACT(HOUR FROM created_at)::int AS hour
      FROM fifo_orders WHERE created_at > now() - interval '24 hours' ORDER BY created_at DESC LIMIT 1000
  `).catch(() => []);

  // Volume spike per merchant in the last hour vs 7-day hourly baseline.
  const spikes = await rows<any>("fifo", `
    WITH win AS (
      SELECT merchant_id, COUNT(*)::int AS n FROM fifo_orders
       WHERE created_at > now() - ($1 * interval '1 minute') GROUP BY merchant_id
    ), base AS (
      SELECT merchant_id, (COUNT(*)::float / (7*24)) AS per_hour FROM fifo_orders
       WHERE created_at > now() - interval '7 days' GROUP BY merchant_id
    )
    SELECT w.merchant_id, w.n, COALESCE(b.per_hour,0) AS per_hour FROM win w LEFT JOIN base b USING (merchant_id)
  `, [SPIKE_WINDOW_MIN]).catch(() => []);

  let raised = 0;
  for (const sp of spikes) {
    if (sp.n >= SPIKE_MIN && sp.n >= SPIKE_FACTOR * Math.max(1, sp.per_hour)) {
      await recordFraudAlert({ merchantId: sp.merchant_id, type: "ANOMALY", severity: "HIGH",
        detail: `volume spike: ${sp.n} orders in ${SPIKE_WINDOW_MIN}m (~${sp.per_hour.toFixed(1)}/h baseline)`,
        payload: { kind: "VOLUME_SPIKE", count: sp.n, baseline_per_hour: sp.per_hour } });
      buckets.VOLUME_SPIKE++; raised++;
    }
  }

  for (const o of recent) {
    if (seen.has(o.id)) continue;
    const amt = Number(o.amount_minor);
    const st = statByMerchant.get(o.merchant_id);
    let flagged: { kind: string; detail: string; severity: "MEDIUM" | "HIGH" } | null = null;

    if (st && st.n >= 5 && st.sd > 0 && amt > AMOUNT_FLOOR_MINOR && amt > st.mean + Z_THRESHOLD * st.sd) {
      const z = ((amt - st.mean) / st.sd).toFixed(1);
      flagged = { kind: "AMOUNT_OUTLIER", detail: `amount ${amt / 100} is ${z}σ above merchant mean ${(st.mean / 100).toFixed(0)}`, severity: "HIGH" };
    } else if ((o.hour >= OFFHOURS_START && o.hour < OFFHOURS_END) && amt >= OFFHOURS_AMOUNT_MINOR) {
      flagged = { kind: "OFFHOURS_HIGH_VALUE", detail: `high-value ${amt / 100} created at off-hours (${o.hour}:00)`, severity: "MEDIUM" };
    }

    if (flagged) {
      await recordFraudAlert({ orderId: o.id, orderRef: o.order_ref, merchantId: o.merchant_id, type: "ANOMALY",
        severity: flagged.severity, detail: flagged.detail, payload: { kind: flagged.kind } });
      buckets[flagged.kind] = (buckets[flagged.kind] ?? 0) + 1; raised++;
    }
  }

  return { scanned: recent.length, raised, buckets };
}
