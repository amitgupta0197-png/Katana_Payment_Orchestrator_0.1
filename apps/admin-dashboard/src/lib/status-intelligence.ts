// Status Intelligence Engine (BRD Layer 2) + Smart Matching Engine (BRD Layer 3).
//
// The recon engine (fifo-recon.ts) compares *completed* orders to the ledger after
// the fact. This module is the live, multi-source status brain: every channel that
// knows something about a transaction (gateway API/webhook, bank API/statement, SMS
// & email parsers, trader uploads, UTR-verification APIs, NPCI & settlement reports,
// pool-account monitors) emits a *signal*. Each signal is matched to an order with a
// confidence score (Layer 3) and the resolver collapses all signals for an order into
// ONE canonical status (Layer 2):
//
//   INITIATED → PROCESSING → PENDING → SUCCESS → SETTLED
//   …or FAILED / REVERSED / CHARGEBACK / DUPLICATE / MISMATCH / UNDER_REVIEW.
//
// Design notes:
//  - Sources have a trust weight; conflicting authoritative signals resolve to MISMATCH
//    (routed to ops review) rather than silently picking a winner.
//  - Reversal / chargeback / duplicate are exception overrides — once asserted by a
//    trusted source they win over a prior SUCCESS.
//  - Matching is tiered exactly per BRD Layer 3 (UTR/RRN → amount/time → VPA/name →
//    narration/pool) with 100 / 90 / 75 / <75 confidence bands.

import { rows } from "@/lib/pg";

export type SignalSource =
  | "GATEWAY_API" | "GATEWAY_WEBHOOK" | "BANK_API" | "BANK_STATEMENT"
  | "EMAIL_PARSER" | "SMS_PARSER" | "TRADER_UPLOAD" | "UTR_VERIFICATION"
  | "NPCI_REPORT" | "SETTLEMENT_REPORT" | "POOL_MONITOR";

export type ReportedStatus =
  | "INITIATED" | "PROCESSING" | "PENDING" | "SUCCESS" | "FAILED"
  | "REVERSED" | "CHARGEBACK" | "SETTLED" | "DUPLICATE";

export type CanonicalStatus =
  | "INITIATED" | "PROCESSING" | "PENDING" | "SUCCESS" | "FAILED"
  | "REVERSED" | "CHARGEBACK" | "DUPLICATE" | "MISMATCH" | "UNDER_REVIEW" | "SETTLED";

export type MatchMethod = "UTR_RRN" | "AMOUNT_TIME" | "VPA_NAME" | "NARRATION_POOL" | "MANUAL" | "UNMATCHED";

// Source trust weight (0-100). Higher = more authoritative when signals conflict.
// NPCI / bank / settlement reports are ground truth; parsers and trader uploads are
// advisory and never resolve a final state on their own.
export const SOURCE_TRUST: Record<SignalSource, number> = {
  NPCI_REPORT: 100,
  BANK_API: 96,
  SETTLEMENT_REPORT: 95,
  UTR_VERIFICATION: 92,
  GATEWAY_API: 90,
  GATEWAY_WEBHOOK: 85,
  BANK_STATEMENT: 80,
  POOL_MONITOR: 72,
  EMAIL_PARSER: 60,
  SMS_PARSER: 55,
  TRADER_UPLOAD: 40,
};

// Confidence at/above this is auto-attached; below routes to manual review.
export const AUTO_MATCH_THRESHOLD = 75;
// A signal must clear this trust to assert a *terminal* state on its own.
const TRUSTED_FOR_TERMINAL = 75;
// Amount tolerance (minor units) before two signals are deemed to disagree.
const AMOUNT_TOLERANCE = 0n;
// Amount+time matching window.
const TIME_WINDOW_TIGHT_MS = 2 * 3600_000;   // ±2h  → 90
const TIME_WINDOW_LOOSE_MS = 24 * 3600_000;  // ±24h → 75

export interface SignalInput {
  source: SignalSource;
  reported_status: ReportedStatus;
  order_ref?: string;        // if the source already knows the order
  utr?: string;
  rrn?: string;
  amount_minor?: bigint | number | string;
  customer_vpa?: string;
  customer_name?: string;
  narration?: string;
  pool_account?: string;
  signal_time?: string;      // ISO; defaults to now
  payload?: Record<string, unknown>;
  created_by?: string;
}

interface OrderRow {
  id: string; order_ref: string; merchant_id: string; direction: string;
  amount_minor: string; customer_name: string | null; customer_phone: string | null;
  utr: string | null; txn_ref: string | null; status: string; created_at: string;
}

interface MatchResult { order: OrderRow | null; confidence: number; method: MatchMethod; detail: string }

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// ── Layer 3: Smart Matching ────────────────────────────────────────────────────
// Tiered matching against fifo_orders. Returns the best candidate + confidence band.
// Priority 1 UTR/RRN (100) → P2 amount+time (90/75) → P3 VPA/name+amount (75) →
// P4 narration/pool reference (≤70, manual review).
export async function smartMatch(sig: SignalInput): Promise<MatchResult> {
  const amount = sig.amount_minor != null ? BigInt(String(sig.amount_minor)) : null;
  const when = sig.signal_time ? new Date(sig.signal_time).getTime() : Date.now();

  // Priority 1 — UTR / RRN exact match (deterministic identifier).
  const utrKey = sig.utr ?? sig.rrn ?? null;
  if (utrKey) {
    const hit = await rows<OrderRow>("fifo", `
      SELECT id::text, order_ref, merchant_id, direction, amount_minor::text,
             customer_name, customer_phone, utr, txn_ref, status, created_at
        FROM fifo_orders WHERE utr = $1 ORDER BY created_at DESC LIMIT 2
    `, [utrKey]);
    if (hit.length === 1) return { order: hit[0], confidence: 100, method: "UTR_RRN", detail: `exact UTR/RRN ${utrKey}` };
    if (hit.length > 1)   return { order: hit[0], confidence: 100, method: "UTR_RRN", detail: `UTR ${utrKey} on ${hit.length} orders (duplicate)` };
  }

  // Priority 2 — amount + timestamp proximity.
  if (amount != null) {
    const cands = await rows<OrderRow>("fifo", `
      SELECT id::text, order_ref, merchant_id, direction, amount_minor::text,
             customer_name, customer_phone, utr, txn_ref, status, created_at
        FROM fifo_orders
       WHERE amount_minor = $1
         AND created_at BETWEEN $2::timestamptz - interval '24 hours'
                            AND $2::timestamptz + interval '24 hours'
       ORDER BY created_at DESC LIMIT 10
    `, [amount.toString(), new Date(when).toISOString()]);

    // Refine with Priority 3 signals (VPA/name) when several amount matches exist.
    const nameKey = norm(sig.customer_name);
    const vpaUser = norm(sig.customer_vpa).split("@")[0];
    const scored = cands.map((o) => {
      const dt = Math.abs(new Date(o.created_at).getTime() - when);
      let conf = dt <= TIME_WINDOW_TIGHT_MS ? 90 : dt <= TIME_WINDOW_LOOSE_MS ? 75 : 60;
      let method: MatchMethod = "AMOUNT_TIME";
      const oname = norm(o.customer_name);
      if (nameKey && oname && (oname.includes(nameKey) || nameKey.includes(oname))) { conf = Math.max(conf, 80); method = "VPA_NAME"; }
      else if (vpaUser && oname && oname.replace(/\s+/g, "").includes(vpaUser)) { conf = Math.max(conf, 78); method = "VPA_NAME"; }
      return { o, conf, method, dt };
    }).sort((a, b) => b.conf - a.conf || a.dt - b.dt);

    if (scored.length === 1) return { order: scored[0].o, confidence: scored[0].conf, method: scored[0].method, detail: "amount+time unique" };
    if (scored.length > 1 && scored[0].conf > scored[1].conf)
      return { order: scored[0].o, confidence: scored[0].conf, method: scored[0].method, detail: "amount+time best of " + scored.length };
    if (scored.length > 1) // ambiguous tie → needs human disambiguation
      return { order: scored[0].o, confidence: Math.min(scored[0].conf, 70), method: scored[0].method, detail: `ambiguous: ${scored.length} equal candidates` };
  }

  // Priority 4 — bank narration / pool reference containing the order or txn ref.
  const blob = norm(`${sig.narration ?? ""} ${sig.pool_account ?? ""}`);
  if (blob) {
    const cands = await rows<OrderRow>("fifo", `
      SELECT id::text, order_ref, merchant_id, direction, amount_minor::text,
             customer_name, customer_phone, utr, txn_ref, status, created_at
        FROM fifo_orders ORDER BY created_at DESC LIMIT 500
    `);
    const hit = cands.find((o) => blob.includes(norm(o.order_ref)) || (o.txn_ref && blob.includes(norm(o.txn_ref))));
    if (hit) return { order: hit, confidence: 70, method: "NARRATION_POOL", detail: "ref found in narration/pool" };
  }

  return { order: null, confidence: 0, method: "UNMATCHED", detail: "no candidate" };
}

// ── Signal ingestion ────────────────────────────────────────────────────────────
// Records a raw signal, smart-matches it to an order, and (if matched) re-resolves
// that order's canonical status. Returns the stored signal + resolution.
export async function ingestSignal(sig: SignalInput): Promise<{
  signal_id: string; matched: boolean; order_ref: string | null; confidence: number;
  method: MatchMethod; review: string; resolution?: Awaited<ReturnType<typeof resolveStatus>>;
}> {
  // If the source already names the order, trust it (confidence 100, MANUAL-ish UTR path).
  let order: OrderRow | null = null;
  let confidence = 0;
  let method: MatchMethod = "UNMATCHED";
  let detail = "";

  if (sig.order_ref) {
    const o = (await rows<OrderRow>("fifo", `
      SELECT id::text, order_ref, merchant_id, direction, amount_minor::text,
             customer_name, customer_phone, utr, txn_ref, status, created_at
        FROM fifo_orders WHERE order_ref = $1 LIMIT 1
    `, [sig.order_ref]))[0];
    if (o) { order = o; confidence = 100; method = "UTR_RRN"; detail = "source-supplied order_ref"; }
  }
  if (!order) { const m = await smartMatch(sig); order = m.order; confidence = m.confidence; method = m.method; detail = m.detail; }

  const review = !order ? "NEEDS_REVIEW" : confidence >= AUTO_MATCH_THRESHOLD ? "AUTO" : "NEEDS_REVIEW";
  const attach = review === "AUTO" ? order : null; // only auto-attach confident matches

  const ins = (await rows<{ id: string }>("fifo", `
    INSERT INTO fifo_status_signals
      (order_id, order_ref, source, reported_status, utr, rrn, amount_minor,
       customer_vpa, customer_name, narration, pool_account, signal_time,
       confidence, match_method, review_status, payload, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, now()),
            $13, $14, $15, $16::jsonb, $17)
    RETURNING id::text
  `, [
    attach?.id ?? null, order?.order_ref ?? sig.order_ref ?? null, sig.source, sig.reported_status,
    sig.utr ?? null, sig.rrn ?? null, sig.amount_minor != null ? BigInt(String(sig.amount_minor)).toString() : null,
    sig.customer_vpa ?? null, sig.customer_name ?? null, sig.narration ?? null, sig.pool_account ?? null,
    sig.signal_time ?? null, confidence, method, review, JSON.stringify({ ...sig.payload, match_detail: detail }),
    sig.created_by ?? null,
  ]))[0];

  const out: any = {
    signal_id: ins.id, matched: !!attach, order_ref: order?.order_ref ?? sig.order_ref ?? null,
    confidence, method, review,
  };
  if (attach) out.resolution = await resolveStatus(attach.id);
  return out;
}

// ── Layer 2: Canonical status resolution ─────────────────────────────────────────
// Collapse all attached signals for an order into one canonical status, persist the
// snapshot to fifo_txn_status, and return it.
export async function resolveStatus(orderId: string): Promise<{
  order_ref: string; canonical_status: CanonicalStatus; confidence: number;
  resolved_from: string | null; signal_count: number; reason: string;
}> {
  const o = (await rows<OrderRow>("fifo", `
    SELECT id::text, order_ref, merchant_id, direction, amount_minor::text,
           customer_name, customer_phone, utr, txn_ref, status, created_at
      FROM fifo_orders WHERE id = $1::uuid LIMIT 1
  `, [orderId]))[0];
  if (!o) throw Object.assign(new Error("order not found"), { status: 404 });

  const signals = await rows<{
    source: SignalSource; reported_status: ReportedStatus; confidence: string;
    amount_minor: string | null; utr: string | null; signal_time: string;
  }>("fifo", `
    SELECT source, reported_status, confidence::text, amount_minor::text, utr, signal_time
      FROM fifo_status_signals
     WHERE order_id = $1::uuid AND review_status IN ('AUTO','RESOLVED')
     ORDER BY signal_time ASC
  `, [orderId]);

  const resolution = resolveFromSignals(o, signals);

  await rows("fifo", `
    INSERT INTO fifo_txn_status (order_id, order_ref, merchant_id, canonical_status, confidence, resolved_from, signal_count, reason, updated_at)
    VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, now())
    ON CONFLICT (order_id) DO UPDATE SET
      canonical_status = EXCLUDED.canonical_status, confidence = EXCLUDED.confidence,
      resolved_from = EXCLUDED.resolved_from, signal_count = EXCLUDED.signal_count,
      reason = EXCLUDED.reason, updated_at = now()
  `, [orderId, o.order_ref, o.merchant_id, resolution.canonical_status, resolution.confidence,
      resolution.resolved_from, signals.length, resolution.reason]).catch(() => {});

  return { order_ref: o.order_ref, signal_count: signals.length, ...resolution };
}

// Pure resolution logic (exported for unit testing — no DB).
export function resolveFromSignals(
  order: { amount_minor: string; status: string },
  signals: { source: SignalSource; reported_status: ReportedStatus; confidence: string; amount_minor: string | null }[],
): { canonical_status: CanonicalStatus; confidence: number; resolved_from: string | null; reason: string } {
  if (signals.length === 0) {
    // No external signal yet — fall back to the order's own operational state.
    const seeded = seedFromOrderStatus(order.status);
    return { canonical_status: seeded, confidence: 50, resolved_from: "ORDER", reason: `no external signals; seeded from order status ${order.status}` };
  }

  // Trust- and recency-weighted: later, more-trusted signals dominate.
  const ranked = [...signals].sort((a, b) =>
    (SOURCE_TRUST[b.source] * Number(b.confidence)) - (SOURCE_TRUST[a.source] * Number(a.confidence)));
  const best = ranked[0];
  const trusted = ranked.filter((s) => SOURCE_TRUST[s.source] >= TRUSTED_FOR_TERMINAL && Number(s.confidence) >= AUTO_MATCH_THRESHOLD);

  // 1) Exception overrides — asserted by ANY trusted source, regardless of progress.
  const has = (st: ReportedStatus) => trusted.some((s) => s.reported_status === st);
  if (has("CHARGEBACK")) return { canonical_status: "CHARGEBACK", confidence: 98, resolved_from: srcOf(trusted, "CHARGEBACK"), reason: "chargeback asserted by trusted source" };
  if (has("REVERSED"))   return { canonical_status: "REVERSED",   confidence: 95, resolved_from: srcOf(trusted, "REVERSED"),   reason: "reversal asserted by trusted source" };
  if (has("DUPLICATE"))  return { canonical_status: "DUPLICATE",  confidence: 92, resolved_from: srcOf(trusted, "DUPLICATE"),  reason: "duplicate UTR/RRN detected" };

  // 2) Amount disagreement across signals → MISMATCH.
  const amounts = new Set(signals.map((s) => s.amount_minor).filter((a): a is string => a != null));
  amounts.add(order.amount_minor);
  if (amounts.size > 1 && !withinTolerance([...amounts])) {
    return { canonical_status: "MISMATCH", confidence: 88, resolved_from: best.source, reason: `amount disagreement across sources: ${[...amounts].join(" vs ")}` };
  }

  // 3) Terminal-state conflict (one trusted SUCCESS, another trusted FAILED) → MISMATCH.
  const terminalSet = new Set(trusted.map((s) => s.reported_status).filter((st) => st === "SUCCESS" || st === "FAILED"));
  if (terminalSet.has("SUCCESS") && terminalSet.has("FAILED"))
    return { canonical_status: "MISMATCH", confidence: 85, resolved_from: best.source, reason: "trusted sources disagree (success vs failed)" };

  // 4) Low confidence everywhere → UNDER_REVIEW.
  if (trusted.length === 0)
    return { canonical_status: "UNDER_REVIEW", confidence: Math.round(Number(best.confidence)), resolved_from: best.source, reason: "no source cleared the trust/confidence bar" };

  // 5) Settled overrides plain success when a settlement source confirms it.
  const settledByReport = trusted.some((s) =>
    s.reported_status === "SETTLED" || (s.source === "SETTLEMENT_REPORT" && s.reported_status === "SUCCESS"));
  if (settledByReport) return { canonical_status: "SETTLED", confidence: 96, resolved_from: srcOf(trusted, "SETTLED") ?? "SETTLEMENT_REPORT", reason: "settlement confirmed by trusted report" };

  // 6) Otherwise take the highest trust×confidence signal's status.
  const map: Record<ReportedStatus, CanonicalStatus> = {
    INITIATED: "INITIATED", PROCESSING: "PROCESSING", PENDING: "PENDING", SUCCESS: "SUCCESS",
    FAILED: "FAILED", REVERSED: "REVERSED", CHARGEBACK: "CHARGEBACK", SETTLED: "SETTLED", DUPLICATE: "DUPLICATE",
  };
  const winner = trusted[0];
  return {
    canonical_status: map[winner.reported_status],
    confidence: Math.round(SOURCE_TRUST[winner.source] * Number(winner.confidence) / 100),
    resolved_from: winner.source,
    reason: `${winner.source} reported ${winner.reported_status} (trust ${SOURCE_TRUST[winner.source]})`,
  };
}

function srcOf(list: { source: SignalSource; reported_status: ReportedStatus }[], st: ReportedStatus): string | null {
  return list.find((s) => s.reported_status === st)?.source ?? null;
}
function withinTolerance(vals: string[]): boolean {
  try {
    const nums = vals.map((v) => BigInt(v));
    const min = nums.reduce((a, b) => (a < b ? a : b));
    const max = nums.reduce((a, b) => (a > b ? a : b));
    return max - min <= AMOUNT_TOLERANCE;
  } catch { return false; }
}
function seedFromOrderStatus(s: string): CanonicalStatus {
  switch (s) {
    case "COMPLETED": return "SUCCESS";
    case "SETTLED": return "SETTLED";
    case "FAILED": case "REJECTED": case "CANCELLED": return "FAILED";
    case "DISPUTE": return "CHARGEBACK";
    case "REFUND": return "REVERSED";
    case "HOLD": return "UNDER_REVIEW";
    case "PROCESSING": case "PROOF_UPLOADED": case "ASSIGNED": case "ACCEPTED": return "PROCESSING";
    case "QUEUED": case "VALIDATED": return "PENDING";
    default: return "INITIATED";
  }
}

// ── Read models for the console ──────────────────────────────────────────────────

export const FUNNEL_ORDER: CanonicalStatus[] = [
  "INITIATED", "PROCESSING", "PENDING", "SUCCESS", "SETTLED",
  "FAILED", "REVERSED", "CHARGEBACK", "DUPLICATE", "MISMATCH", "UNDER_REVIEW",
];

export async function getFunnel(): Promise<{ funnel: Record<string, number>; total: number; review_pending: number }> {
  const counts = await rows<{ canonical_status: string; n: string }>("fifo", `
    SELECT canonical_status, COUNT(*)::text AS n FROM fifo_txn_status GROUP BY canonical_status
  `).catch(() => []);
  const funnel: Record<string, number> = {};
  for (const s of FUNNEL_ORDER) funnel[s] = 0;
  let total = 0;
  for (const c of counts) { funnel[c.canonical_status] = Number(c.n); total += Number(c.n); }
  const rev = (await rows<{ n: string }>("fifo", `
    SELECT COUNT(*)::text AS n FROM fifo_status_signals WHERE review_status = 'NEEDS_REVIEW'
  `).catch(() => [{ n: "0" }]))[0];
  return { funnel, total, review_pending: Number(rev?.n ?? 0) };
}

export async function getReviewQueue(limit = 100): Promise<any[]> {
  return rows<any>("fifo", `
    SELECT id::text, order_ref, source, reported_status, utr, rrn, amount_minor::text,
           customer_vpa, customer_name, narration, confidence::text, match_method, signal_time
      FROM fifo_status_signals
     WHERE review_status = 'NEEDS_REVIEW'
     ORDER BY created_at DESC LIMIT $1
  `, [limit]).catch(() => []);
}

export async function getTransactionView(ref: string): Promise<{
  order: any | null; canonical: any | null; signals: any[];
} | null> {
  const order = (await rows<any>("fifo", `
    SELECT id::text, order_ref, merchant_id, direction, amount_minor::text, currency,
           customer_name, customer_phone, utr, txn_ref, status, created_at, completed_at
      FROM fifo_orders WHERE order_ref = $1 LIMIT 1
  `, [ref]))[0] ?? null;
  if (!order) return null;
  const canonical = (await rows<any>("fifo", `
    SELECT canonical_status, confidence::text, resolved_from, signal_count, reason, updated_at
      FROM fifo_txn_status WHERE order_id = $1::uuid LIMIT 1
  `, [order.id]))[0] ?? null;
  const signals = await rows<any>("fifo", `
    SELECT id::text, source, reported_status, utr, rrn, amount_minor::text, customer_vpa,
           customer_name, narration, confidence::text, match_method, review_status, signal_time
      FROM fifo_status_signals WHERE order_id = $1::uuid ORDER BY signal_time ASC
  `, [order.id]);
  return { order, canonical, signals };
}

// Manual match: attach a NEEDS_REVIEW signal to an order and re-resolve.
export async function manualMatch(signalId: string, orderRef: string, actor: string): Promise<{ ok: boolean; resolution?: any; error?: string }> {
  const o = (await rows<{ id: string }>("fifo", `SELECT id::text FROM fifo_orders WHERE order_ref = $1 LIMIT 1`, [orderRef]))[0];
  if (!o) return { ok: false, error: `order ${orderRef} not found` };
  const upd = await rows("fifo", `
    UPDATE fifo_status_signals
       SET order_id = $1::uuid, order_ref = $2, confidence = GREATEST(confidence, 100),
           match_method = 'MANUAL', review_status = 'RESOLVED',
           payload = jsonb_set(payload, '{manual_matched_by}', to_jsonb($3::text))
     WHERE id = $4::uuid AND review_status = 'NEEDS_REVIEW'
     RETURNING id
  `, [o.id, orderRef, actor, signalId]);
  if (upd.length === 0) return { ok: false, error: "signal not found or already resolved" };
  const resolution = await resolveStatus(o.id);
  return { ok: true, resolution };
}
