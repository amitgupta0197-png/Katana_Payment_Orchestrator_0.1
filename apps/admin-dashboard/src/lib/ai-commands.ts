// Slash-command dispatcher (BRD §14 P10 examples).
// /merchant MID  /provider PRV  /submid SM  /txn TXN  /settlement BATCH
// /reserve MID   /risk MID      /treasury   /exceptions   /retry_payout ID

import { rows } from "@/lib/pg";

export interface CommandResult {
  command: string; arg: string;
  text: string;
  data?: Record<string, unknown>;
}

async function fmtMerchant(arg: string): Promise<CommandResult> {
  const r = await rows<any>("merchant", `
    SELECT id::text, legal_name, brand_name, stage, risk_tier
      FROM merchants WHERE id::text=$1 OR merchant_code=$1 LIMIT 1
  `, [arg]).catch(() => []);
  if (!r.length) return { command: "/merchant", arg, text: "not found" };
  const m = r[0];
  return {
    command: "/merchant", arg,
    text: `${m.brand_name || m.legal_name} · stage=${m.stage} · risk=${m.risk_tier ?? "?"}`,
    data: m,
  };
}

async function fmtProvider(arg: string): Promise<CommandResult> {
  const r = await rows<any>("provider", `
    SELECT id::text, code, legal_name, kyc_status, status
      FROM providers WHERE code=$1 OR id::text=$1 LIMIT 1
  `, [arg]).catch(() => []);
  if (!r.length) return { command: "/provider", arg, text: "not found" };
  const h = await rows<any>("routingEngine", `
    SELECT circuit_state, consecutive_failures, success_rate::float AS success_rate, p95_latency_ms
      FROM provider_health_snapshot WHERE provider_code=$1
  `, [arg.toUpperCase()]).catch(() => []);
  const ph = h[0] ?? {};
  const text = `${r[0].legal_name} · KYC=${r[0].kyc_status} · status=${r[0].status}` +
               (ph.circuit_state ? ` · circuit=${ph.circuit_state} fails=${ph.consecutive_failures} success=${(ph.success_rate*100).toFixed(1)}% p95=${ph.p95_latency_ms}ms` : "");
  return { command: "/provider", arg, text, data: { provider: r[0], health: ph } };
}

async function fmtTxn(arg: string): Promise<CommandResult> {
  const r = await rows<any>("checkout", `
    SELECT id::text, txn_id, status, amount_minor::text, currency, method, selected_rail, merchant_id, created_at
      FROM checkout_orders WHERE txn_id=$1 OR id::text=$1 LIMIT 1
  `, [arg]).catch(() => []);
  if (!r.length) return { command: "/txn", arg, text: "not found" };
  const o = r[0];
  return {
    command: "/txn", arg,
    text: `${o.txn_id} · ${o.method} · ${o.currency} ${o.amount_minor} minor · ${o.status} via ${o.selected_rail ?? "—"}`,
    data: o,
  };
}

async function fmtSettlement(arg: string): Promise<CommandResult> {
  const r = await rows<any>("settlement", `
    SELECT id::text, merchant_id, status, gross_amount, net_payable, currency, cycle_for_date
      FROM settlement_batches WHERE id::text=$1 OR merchant_id=$1
      ORDER BY cycle_for_date DESC LIMIT 5
  `, [arg]).catch(() => []);
  if (!r.length) return { command: "/settlement", arg, text: "no batches" };
  const lines = r.map((b: any) => `${b.cycle_for_date.toString().slice(0,10)} · ${b.merchant_id} · gross ${b.gross_amount} · net ${b.net_payable} · ${b.status}`).join("\n");
  return { command: "/settlement", arg, text: lines, data: { batches: r } };
}

async function fmtReserve(arg: string): Promise<CommandResult> {
  const r = await rows<any>("ledger", `
    SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_minor),0)::text AS held
      FROM reserve_release_calendar WHERE merchant_id=$1 AND status='SCHEDULED'
  `, [arg]).catch(() => []);
  const x = r[0] ?? { n: 0, held: "0" };
  return { command: "/reserve", arg, text: `${arg}: ${x.n} scheduled releases, ${x.held} minor held` };
}

async function fmtRisk(arg: string): Promise<CommandResult> {
  const r = await rows<any>("riskVelocity", `
    SELECT severity, status, summary, opened_at FROM aml_cases
      WHERE entity_type='merchant' AND entity_id=$1
      ORDER BY opened_at DESC LIMIT 5
  `, [arg]).catch(() => []);
  if (!r.length) return { command: "/risk", arg, text: "no AML cases" };
  const lines = r.map((c: any) => `[${c.severity}] ${c.status} · ${c.summary}`).join("\n");
  return { command: "/risk", arg, text: lines };
}

async function fmtTreasury(): Promise<CommandResult> {
  const fx = await rows<any>("ledger", `
    SELECT source_currency, target_currency, rate_decimal::float AS rate
      FROM fx_quotes ORDER BY quoted_at DESC LIMIT 8
  `).catch(() => []);
  return {
    command: "/treasury", arg: "",
    text: fx.map((f: any) => `${f.source_currency}->${f.target_currency} ${f.rate}`).join(" · ") || "no FX",
    data: { quotes: fx },
  };
}

async function fmtExceptions(): Promise<CommandResult> {
  const inc = await rows<any>("audit",
    `SELECT incident_id::text, severity, status, title FROM incidents
      WHERE status IN ('OPEN','INVESTIGATING','MITIGATING')
      ORDER BY opened_at DESC LIMIT 10`).catch(() => []);
  const dlq = await rows<any>("notification",
    `SELECT COUNT(*)::int AS n FROM webhook_outbox WHERE status='DEAD_LETTER'`).catch(() => []);
  const txt = (inc.length ? inc.map((i:any) => `[${i.severity}] ${i.title} (${i.status})`).join("\n") : "no open incidents")
    + `\nWebhook DLQ: ${dlq[0]?.n ?? 0}`;
  return { command: "/exceptions", arg: "", text: txt, data: { incidents: inc, dlq: dlq[0]?.n ?? 0 } };
}

async function fmtSubmid(arg: string): Promise<CommandResult> {
  const r = await rows<any>("mid", `
    SELECT id::text, sub_mid_code, kyc_status, settlement_enabled, traffic_mode, status
      FROM sub_mids WHERE sub_mid_code=$1 OR id::text=$1 LIMIT 1
  `, [arg]).catch(() => []);
  if (!r.length) return { command: "/submid", arg, text: "not found" };
  const s = r[0];
  return { command: "/submid", arg, text: `${s.sub_mid_code} · mode=${s.traffic_mode} kyc=${s.kyc_status} settle=${s.settlement_enabled} status=${s.status}`, data: s };
}

async function fmtRetryPayout(arg: string): Promise<CommandResult> {
  const r = await rows<any>("notification", `
    UPDATE webhook_outbox SET status='PENDING', next_attempt_at=now(), last_error=NULL
     WHERE outbox_id=$1::uuid AND status='DEAD_LETTER'
     RETURNING outbox_id::text, status, merchant_id
  `, [arg]).catch(() => []);
  if (!r.length) return { command: "/retry_payout", arg, text: "no DLQ row matched" };
  return { command: "/retry_payout", arg, text: `re-queued ${r[0].outbox_id} for ${r[0].merchant_id}`, data: r[0] };
}

export async function runCommand(raw: string): Promise<CommandResult> {
  const tokens = raw.trim().split(/\s+/);
  const cmd = tokens[0] ?? "";
  const arg = tokens.slice(1).join(" ");
  switch (cmd) {
    case "/merchant":    return fmtMerchant(arg);
    case "/provider":    return fmtProvider(arg);
    case "/submid":      return fmtSubmid(arg);
    case "/txn":         return fmtTxn(arg);
    case "/settlement":  return fmtSettlement(arg);
    case "/reserve":     return fmtReserve(arg);
    case "/risk":        return fmtRisk(arg);
    case "/treasury":    return fmtTreasury();
    case "/exceptions":  return fmtExceptions();
    case "/retry_payout":return fmtRetryPayout(arg);
    default:             return { command: cmd, arg, text: `unknown command. try /merchant /provider /submid /txn /settlement /reserve /risk /treasury /exceptions /retry_payout` };
  }
}
