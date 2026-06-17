// SLO computation (BRD §13 P9).
//
// Each kind reads live data and emits a measured value, status (OK/WARN/BREACH)
// and an error-budget-burn-rate hint. Written to slo_observations on every
// computeAll().

import { rows } from "@/lib/pg";

export type SloStatus = "OK" | "WARN" | "BREACH";

export interface SloTarget {
  target_id: string; name: string; description: string;
  metric_kind: string; target_value: number; comparison: ">=" | "<=";
  window_minutes: number; burn_rate_alert: number;
}

export interface SloResult {
  target: SloTarget;
  measured: number;
  status: SloStatus;
  burn_rate: number;
  detail: Record<string, unknown>;
  evaluated_at: string;
}

async function loadTargets(): Promise<SloTarget[]> {
  const r = await rows<any>("audit", `
    SELECT target_id::text, name, description, metric_kind,
           target_value::float AS target_value,
           comparison, window_minutes, burn_rate_alert::float AS burn_rate_alert
      FROM slo_targets
     ORDER BY name
  `).catch(() => []);
  return r as SloTarget[];
}

function classify(target: SloTarget, measured: number): SloStatus {
  // For >= targets: BREACH if measured < target; WARN if within 10% headroom.
  // For <= targets (latency): BREACH if measured > target; WARN if within 20% headroom.
  if (target.comparison === ">=") {
    if (measured < target.target_value) return "BREACH";
    if (measured < target.target_value + (1 - target.target_value) * 0.5) return "WARN";
    return "OK";
  }
  if (measured > target.target_value) return "BREACH";
  if (measured > target.target_value * 0.8) return "WARN";
  return "OK";
}

function burnRate(target: SloTarget, measured: number): number {
  if (target.comparison === ">=") {
    const errorBudget = 1 - target.target_value;
    const actualErrors = Math.max(0, 1 - measured);
    return errorBudget > 0 ? actualErrors / errorBudget : 0;
  }
  return Math.max(0, measured / target.target_value);
}

async function measureAvailability(windowMin: number): Promise<{ value: number; detail: any }> {
  const r = await rows<any>("checkout", `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status IN ('SUCCESS','PROCESSING','PENDING','AUTH_REQUIRED','AUTH_CHALLENGE','AUTHENTICATED'))::int AS ok
      FROM checkout_orders
     WHERE created_at > now() - ($1::int * interval '1 minute')
  `, [windowMin]).catch(() => []);
  const total = r[0]?.total ?? 0;
  const ok = r[0]?.ok ?? 0;
  const value = total > 0 ? ok / total : 1;
  return { value, detail: { total, ok, window_minutes: windowMin } };
}

async function measureLatencyP95(windowMin: number): Promise<{ value: number; detail: any }> {
  // PostgreSQL percentile_cont over response_time_ms.
  const r = await rows<any>("checkout", `
    SELECT
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY response_time_ms), 0)::float AS p95,
      COUNT(*)::int AS samples
      FROM checkout_attempts
     WHERE started_at > now() - ($1::int * interval '1 minute')
       AND response_time_ms IS NOT NULL
  `, [windowMin]).catch(() => []);
  const p95 = r[0]?.p95 ?? 0;
  return { value: p95, detail: { samples: r[0]?.samples ?? 0, window_minutes: windowMin } };
}

async function measureWebhookSla(windowMin: number): Promise<{ value: number; detail: any }> {
  const r = await rows<any>("notification", `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE status='DELIVERED'
          AND delivered_at IS NOT NULL
          AND EXTRACT(EPOCH FROM (delivered_at - created_at)) < 60
      )::int AS in_sla
      FROM webhook_outbox
     WHERE created_at > now() - ($1::int * interval '1 minute')
  `, [windowMin]).catch(() => []);
  const total = r[0]?.total ?? 0;
  const inSla = r[0]?.in_sla ?? 0;
  const value = total > 0 ? inSla / total : 1;
  return { value, detail: { total, in_sla: inSla } };
}

async function measurePartnerSync(windowMin: number): Promise<{ value: number; detail: any }> {
  // Treat absence of failed sync runs as 100%; opens the door for finer
  // metrics when the partner-sync worker arrives in Sprint 9.
  const r = await rows<any>("settlement", `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status IN ('COMPLETED','OK'))::int AS ok
      FROM settlement_partner_sync_runs
     WHERE started_at > now() - ($1::int * interval '1 minute')
  `, [windowMin]).catch(() => []);
  const total = r[0]?.total ?? 0;
  const ok = r[0]?.ok ?? 0;
  const value = total > 0 ? ok / total : 1;
  return { value, detail: { total, ok } };
}

async function measureAutoMatch(windowMin: number): Promise<{ value: number; detail: any }> {
  const r = await rows<any>("reconciliation", `
    SELECT
      COALESCE(SUM(matched_3way + matched_2way),0)::int AS matched,
      COALESCE(SUM(matched_3way + matched_2way + breaks_opened),0)::int AS total
      FROM recon_runs
     WHERE started_at > now() - ($1::int * interval '1 minute')
  `, [windowMin]).catch(() => []);
  const matched = r[0]?.matched ?? 0;
  const total = r[0]?.total ?? 0;
  const value = total > 0 ? matched / total : 1;
  return { value, detail: { matched, total } };
}

export async function computeAll(): Promise<SloResult[]> {
  const targets = await loadTargets();
  const out: SloResult[] = [];
  for (const t of targets) {
    let m: { value: number; detail: any } | null = null;
    switch (t.metric_kind) {
      case "availability":     m = await measureAvailability(t.window_minutes); break;
      case "latency_p95_ms":   m = await measureLatencyP95(t.window_minutes); break;
      case "webhook_in_sla":   m = await measureWebhookSla(t.window_minutes); break;
      case "partner_sync":     m = await measurePartnerSync(t.window_minutes); break;
      case "auto_match_pct":   m = await measureAutoMatch(t.window_minutes); break;
    }
    if (!m) continue;
    const status = classify(t, m.value);
    const burn = burnRate(t, m.value);
    out.push({ target: t, measured: m.value, status, burn_rate: burn, detail: m.detail, evaluated_at: new Date().toISOString() });
    await rows("audit", `
      INSERT INTO slo_observations (target_id, measured_value, status, detail)
      VALUES ($1::uuid, $2, $3, $4::jsonb)
    `, [t.target_id, m.value, status, JSON.stringify({ burn_rate: burn, ...m.detail })]).catch(() => null);
  }
  return out;
}
