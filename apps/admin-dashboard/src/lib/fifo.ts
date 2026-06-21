// FIFO Payment Operations engine (PayTech BRD §15/§16).
//
// Order intake -> validate -> risk -> FIFO queue -> operator assignment, with an
// append-only status lifecycle. Operators claim the head of the queue (highest
// priority, then oldest). Completion posts to the existing ledger so the order
// flows into the settlement engine we already built.

import { rows } from "@/lib/pg";
import { randomBytes } from "crypto";
import { computeRiskScore } from "@/lib/risk";
import { postJournal } from "@/lib/ledger";

export type Direction = "PAYIN" | "PAYOUT";

// Allowed status transitions (BRD §16 lifecycle).
export const NEXT: Record<string, string[]> = {
  CREATED:        ["VALIDATED", "REJECTED"],
  VALIDATED:      ["QUEUED", "HOLD"],
  QUEUED:         ["ASSIGNED", "CANCELLED"],
  ASSIGNED:       ["ACCEPTED", "QUEUED"],          // reassign returns to queue
  ACCEPTED:       ["PROCESSING", "QUEUED"],
  PROCESSING:     ["PROOF_UPLOADED", "FAILED", "HOLD"],
  PROOF_UPLOADED: ["COMPLETED", "REJECTED", "PROCESSING"],
  COMPLETED:      ["SETTLED", "REFUND", "DISPUTE"],
  HOLD:           ["VALIDATED", "QUEUED", "REJECTED", "CANCELLED"],
};

export function canTransition(from: string, to: string): boolean {
  return (NEXT[from] ?? []).includes(to);
}

export async function recordEvent(input: {
  orderId: string; from: string | null; to: string;
  actor?: string | null; actorKind?: string; reason?: string; payload?: Record<string, unknown>;
}): Promise<void> {
  await rows("fifo", `
    INSERT INTO fifo_order_events (order_id, from_status, to_status, actor, actor_kind, reason, payload)
    VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)
  `, [input.orderId, input.from, input.to, input.actor ?? null, input.actorKind ?? "system",
      input.reason ?? null, input.payload ? JSON.stringify(input.payload) : null]).catch(() => {});
}

// Generic guarded transition: validates from->to, updates status, records event.
export async function transition(input: {
  orderId: string; to: string; actor?: string | null; actorKind?: string;
  reason?: string; payload?: Record<string, unknown>; set?: Record<string, string | number | null>;
}): Promise<{ ok: boolean; from?: string; error?: string }> {
  const cur = (await rows<{ status: string }>("fifo", `SELECT status FROM fifo_orders WHERE id=$1::uuid`, [input.orderId]))[0];
  if (!cur) return { ok: false, error: "order not found" };
  if (cur.status === input.to) return { ok: true, from: cur.status };
  if (!canTransition(cur.status, input.to)) return { ok: false, from: cur.status, error: `cannot move ${cur.status} -> ${input.to}` };

  const sets = ["status=$2"]; const args: unknown[] = [input.orderId, input.to];
  if (input.to === "COMPLETED") sets.push("completed_at=now()");
  for (const [k, v] of Object.entries(input.set ?? {})) { args.push(v); sets.push(`${k}=$${args.length}`); }
  await rows("fifo", `UPDATE fifo_orders SET ${sets.join(", ")} WHERE id=$1::uuid`, args);
  await recordEvent({ orderId: input.orderId, from: cur.status, to: input.to, actor: input.actor, actorKind: input.actorKind, reason: input.reason, payload: input.payload });
  return { ok: true, from: cur.status };
}

export interface CreateOrderInput {
  merchantId: string; direction: Direction; amountMinor: bigint; currency: string;
  settlementMode: string; customerName?: string; customerPhone?: string; customerEmail?: string;
  purpose?: string; priority?: number; deviceIp?: string; deviceFingerprint?: string;
  actor?: string | null;
}

export interface CreatedOrder {
  id: string; order_ref: string; status: string; queue_position?: number;
  risk_score?: number; risk_decision?: string;
}

export async function createOrder(input: CreateOrderInput): Promise<{ order?: CreatedOrder; error?: string; status?: number }> {
  // FR-003: validate merchant exists + is LIVE before queuing.
  const m = (await rows<{ stage: string }>("merchant", `SELECT stage FROM merchants WHERE merchant_code=$1`, [input.merchantId]).catch(() => []))[0];
  if (!m) return { error: "merchant not found", status: 404 };
  if (m.stage !== "LIVE") return { error: `merchant not LIVE (stage=${m.stage})`, status: 409 };
  if (input.amountMinor <= 0n) return { error: "amount must be > 0", status: 400 };

  const orderRef = "ORD-" + randomBytes(6).toString("hex").toUpperCase();
  const txnRef = "TXN-" + randomBytes(8).toString("hex").toUpperCase();

  const o = (await rows<any>("fifo", `
    INSERT INTO fifo_orders
      (order_ref, merchant_id, direction, amount_minor, currency, settlement_mode,
       customer_name, customer_phone, customer_email, purpose, txn_ref,
       device_ip, device_fingerprint, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'CREATED')
    RETURNING id::text, order_ref, status
  `, [orderRef, input.merchantId, input.direction, input.amountMinor.toString(), input.currency,
      input.settlementMode, input.customerName ?? null, input.customerPhone ?? null,
      input.customerEmail ?? null, input.purpose ?? null, txnRef,
      input.deviceIp ?? null, input.deviceFingerprint ?? null]))[0];
  await recordEvent({ orderId: o.id, from: null, to: "CREATED", actor: input.actor, reason: "order created" });

  // Risk score (FR-003 / §15 step 4). BLOCK -> HOLD for Risk Team.
  let riskTotal = 0, riskDecision = "ALLOW";
  try {
    const risk = await computeRiskScore({
      merchantId: input.merchantId, amountMinor: input.amountMinor, currency: input.currency,
      customerRef: input.customerEmail ?? input.customerPhone, method: input.settlementMode,
    });
    riskTotal = risk.total; riskDecision = risk.decision;
  } catch { /* risk engine unavailable -> proceed as ALLOW */ }

  await transition({ orderId: o.id, to: "VALIDATED", reason: "format + merchant validated", actor: input.actor });
  await rows("fifo", `UPDATE fifo_orders SET validated_at=now(), risk_score=$2, risk_decision=$3 WHERE id=$1::uuid`,
    [o.id, riskTotal, riskDecision]).catch(() => {});

  if (riskDecision === "BLOCK") {
    await transition({ orderId: o.id, to: "HOLD", actorKind: "system", reason: `risk BLOCK (score=${riskTotal})` });
    return { order: { id: o.id, order_ref: o.order_ref, status: "HOLD", risk_score: riskTotal, risk_decision: riskDecision } };
  }

  // Enqueue (FIFO) — QUEUED.
  await transition({ orderId: o.id, to: "QUEUED", reason: "added to FIFO queue", actor: input.actor });
  await rows("fifo", `UPDATE fifo_orders SET queued_at=now() WHERE id=$1::uuid`, [o.id]).catch(() => {});
  await rows("fifo", `
    INSERT INTO fifo_queue (order_id, priority, status) VALUES ($1::uuid, $2, 'QUEUED')
    ON CONFLICT (order_id) DO NOTHING
  `, [o.id, input.priority ?? 0]);

  const pos = (await rows<{ n: number }>("fifo", `
    SELECT COUNT(*)::int AS n FROM fifo_queue WHERE status='QUEUED'
  `))[0]?.n ?? 0;

  return { order: { id: o.id, order_ref: o.order_ref, status: "QUEUED", queue_position: pos, risk_score: riskTotal, risk_decision: riskDecision } };
}

// Operator claims the head of the queue within their capacity + limits.
export async function assignNextForOperator(operatorId: string): Promise<{ assigned?: any; error?: string; status?: number }> {
  const op = (await rows<any>("fifo", `SELECT id::text, status, max_concurrent, max_amount_minor, roles FROM fifo_operators WHERE id=$1::uuid`, [operatorId]))[0];
  if (!op) return { error: "operator not found", status: 404 };
  if (op.status !== "ACTIVE") return { error: `operator ${op.status}`, status: 409 };

  const inflight = (await rows<{ n: number }>("fifo",
    `SELECT COUNT(*)::int AS n FROM fifo_queue WHERE assigned_to=$1::uuid AND status IN ('ASSIGNED','ACCEPTED')`, [operatorId]))[0]?.n ?? 0;
  if (inflight >= op.max_concurrent) return { error: "at max concurrent capacity", status: 409 };

  // FIFO head respecting operator role + amount ceiling. Lock the row.
  const head = (await rows<any>("fifo", `
    SELECT q.id::text AS queue_id, q.order_id::text, o.order_ref, o.amount_minor::text, o.direction, o.merchant_id
      FROM fifo_queue q JOIN fifo_orders o ON o.id = q.order_id
     WHERE q.status='QUEUED'
       AND o.direction = ANY($1::text[])
       AND ($2::bigint IS NULL OR o.amount_minor <= $2::bigint)
     ORDER BY q.priority DESC, q.enqueued_at ASC
     LIMIT 1
     FOR UPDATE OF q SKIP LOCKED
  `, [op.roles, op.max_amount_minor]))[0];
  if (!head) return { error: "queue empty (no eligible item)", status: 404 };

  await rows("fifo", `
    UPDATE fifo_queue SET status='ASSIGNED', assigned_to=$1::uuid, assigned_at=now(),
           sla_due_at=now() + interval '3 minutes'
     WHERE id=$2::uuid
  `, [operatorId, head.queue_id]);
  await transition({ orderId: head.order_id, to: "ASSIGNED", actorKind: "system", reason: `assigned to operator ${op.id}` });

  return { assigned: { queue_id: head.queue_id, order_id: head.order_id, order_ref: head.order_ref, amount_minor: head.amount_minor, direction: head.direction, merchant_id: head.merchant_id } };
}

// Post a completed PAY-IN to the ledger so it flows into the settlement engine
// (mirrors checkout-core: gross debit to PG_FLOAT; net/reserve/MDR credits). The
// idempotency_key makes re-completion safe. Returns the journal id (or null).
export async function settlePayinToLedger(input: {
  merchantId: string; txnRef: string; amountMinor: bigint; currency: string; provider?: string;
}): Promise<string | null> {
  const provider = (input.provider || "MANUAL").toUpperCase();
  const MDR_BPS = 195n, RESERVE_BPS = 500n;
  const commission = (input.amountMinor * MDR_BPS) / 10000n;
  const reserve = (input.amountMinor * RESERVE_BPS) / 10000n;
  const net = input.amountMinor - commission - reserve;
  try {
    const j = await postJournal({
      journal_type: "payment.success",
      narration: `FIFO pay-in ${input.txnRef} via ${provider}`,
      currency: input.currency, merchant_id: input.merchantId,
      ref: { type: "payment", id: input.txnRef },
      idempotency_key: `payment.success:${input.txnRef}`,
      lines: [
        { account_code: `ASSETS.PG_FLOAT.${provider}`, account_type: "ASSET", side: "D", amount_minor: input.amountMinor, currency: input.currency },
        { account_code: `LIABILITIES.MERCHANT_PAYABLE.${input.merchantId}`, account_type: "LIABILITY", side: "C", amount_minor: net, currency: input.currency },
        { account_code: `LIABILITIES.MERCHANT_RESERVE.${input.merchantId}`, account_type: "LIABILITY", side: "C", amount_minor: reserve, currency: input.currency },
        { account_code: `INCOME.MDR_EARNED.PLATFORM`, account_type: "INCOME", side: "C", amount_minor: commission, currency: input.currency },
      ],
    });
    await rows("ledger", `
      INSERT INTO reserve_release_calendar (merchant_id, amount_minor, currency, scheduled_at, status)
      VALUES ($1, $2, $3, now() + interval '7 days', 'SCHEDULED')
    `, [input.merchantId, reserve.toString(), input.currency]).catch(() => {});
    return j.journal_id;
  } catch { return null; }
}

// Resolve the operator record for a logged-in user (by email), auto-registering
// on first use so any granted OPERATOR can work the queue.
export async function operatorForUser(email: string, name?: string, userId?: string): Promise<string | null> {
  const existing = (await rows<{ id: string }>("fifo", `SELECT id::text FROM fifo_operators WHERE email=$1`, [email]).catch(() => []))[0];
  if (existing) return existing.id;
  const r = (await rows<{ id: string }>("fifo", `
    INSERT INTO fifo_operators (user_id, email, name) VALUES ($1, $2, $3)
    ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name
    RETURNING id::text
  `, [userId ?? null, email, name ?? email]).catch(() => []))[0];
  return r?.id ?? null;
}
