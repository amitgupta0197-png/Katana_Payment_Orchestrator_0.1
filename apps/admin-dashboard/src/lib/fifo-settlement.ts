// FIFO settlement batches (PayTech BRD §19, §22, §20). Nets a merchant's
// completed-but-unsettled pay-ins into a batch following the §22 formula, then
// moves MERCHANT_PAYABLE → SETTLEMENT_PAYABLE on the ledger and marks the orders
// SETTLED. Large batches or any manual adjustment require maker-checker (§9) — the
// batch is held PENDING_APPROVAL and finalised on approval.
//
// MDR (1.95%) and rolling reserve (5%) are already withheld per-order at
// completion (settlePayinToLedger), so the batch starts from the accumulated net.
// GST (on the MDR fee) and chargeback holds are withheld here as separate
// liabilities; adjustments are posted against a settlement-adjustment account.

import { rows } from "@/lib/pg";
import { randomBytes } from "crypto";
import { postJournal } from "@/lib/ledger";
import { transition } from "@/lib/fifo";

const MDR_BPS = 195n, RESERVE_BPS = 500n;
const GST_BPS = BigInt(process.env.FIFO_GST_BPS ?? "0");          // GST on the MDR fee, e.g. 1800 = 18%
const APPROVAL_MINOR = BigInt(process.env.FIFO_SETTLEMENT_APPROVAL_MINOR ?? "10000000"); // ₹1,00,000

export interface BatchComputation {
  orders: { id: string; order_ref: string; amount_minor: bigint }[];
  gross: bigint; mdr: bigint; reserve: bigint; gst: bigint; orderNet: bigint;
}

async function computeBatch(merchantId: string): Promise<BatchComputation> {
  const orders = (await rows<any>("fifo", `
    SELECT id::text, order_ref, amount_minor::text FROM fifo_orders
     WHERE merchant_id=$1 AND direction='PAYIN' AND status='COMPLETED' AND settlement_batch_id IS NULL
     ORDER BY completed_at ASC LIMIT 1000
  `, [merchantId])).map((o) => ({ id: o.id, order_ref: o.order_ref, amount_minor: BigInt(o.amount_minor) }));
  let gross = 0n; for (const o of orders) gross += o.amount_minor;
  const mdr = (gross * MDR_BPS) / 10000n;
  const reserve = (gross * RESERVE_BPS) / 10000n;
  const gst = (mdr * GST_BPS) / 10000n;
  const orderNet = gross - mdr - reserve;   // == accumulated MERCHANT_PAYABLE from these orders
  return { orders, gross, mdr, reserve, gst, orderNet };
}

export interface CreateBatchInput {
  merchantId: string; currency?: string; chargebackHoldMinor?: bigint; adjustmentMinor?: bigint; createdBy?: string;
}

export async function createSettlementBatch(input: CreateBatchInput): Promise<{ batch?: any; error?: string; status?: number }> {
  const c = await computeBatch(input.merchantId);
  if (!c.orders.length) return { error: "no unsettled completed pay-ins for merchant", status: 409 };
  const currency = (input.currency ?? "INR").toUpperCase();
  const chargeback = input.chargebackHoldMinor ?? 0n;
  const adjustment = input.adjustmentMinor ?? 0n;
  const net = c.orderNet - c.gst - chargeback + adjustment;
  if (net < 0n) return { error: "net settlement would be negative; reduce holds/adjustment", status: 400 };

  const batchRef = "STL-" + randomBytes(5).toString("hex").toUpperCase();
  const needsApproval = adjustment !== 0n || net >= APPROVAL_MINOR;

  const b = (await rows<any>("fifo", `
    INSERT INTO fifo_settlement_batches
      (batch_ref, merchant_id, currency, order_count, gross_minor, mdr_minor, reserve_minor,
       gst_minor, chargeback_hold_minor, adjustment_minor, net_minor, status, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING id::text, batch_ref
  `, [batchRef, input.merchantId, currency, c.orders.length, c.gross.toString(), c.mdr.toString(),
      c.reserve.toString(), c.gst.toString(), chargeback.toString(), adjustment.toString(), net.toString(),
      needsApproval ? "PENDING_APPROVAL" : "SETTLED", input.createdBy ?? null]))[0];

  // Tag the orders to this batch immediately so a second run can't double-count.
  await rows("fifo", `UPDATE fifo_orders SET settlement_batch_id=$1::uuid WHERE id = ANY($2::uuid[])`,
    [b.id, c.orders.map((o) => o.id)]).catch(() => {});

  if (needsApproval) {
    await rows("fifo", `
      INSERT INTO fifo_approvals (action_type, resource_type, resource_id, merchant_id, amount_minor, currency, detail, maker)
      VALUES ('SETTLEMENT_RELEASE','settlement_batch',$1,$2,$3,$4,$5,$6)
    `, [b.id, input.merchantId, net.toString(), currency,
        `Settle ${c.orders.length} orders, net ${net} (adj ${adjustment})`, input.createdBy ?? null]).catch(() => {});
    return { batch: { id: b.id, batch_ref: b.batch_ref, status: "PENDING_APPROVAL", net_minor: net.toString(), approval_required: true } };
  }

  await finalizeSettlementBatch(b.id, input.createdBy ?? "system");
  return { batch: { id: b.id, batch_ref: b.batch_ref, status: "SETTLED", net_minor: net.toString(), approval_required: false } };
}

// Post the ledger movement for a batch and mark its orders SETTLED. Idempotent on
// batch_ref. Called immediately for small batches, or by the approval decision.
export async function finalizeSettlementBatch(batchId: string, actor: string): Promise<{ ok: boolean; journal_id?: string | null; error?: string }> {
  const b = (await rows<any>("fifo", `
    SELECT id::text, batch_ref, merchant_id, currency, order_count, gross_minor::text,
           gst_minor::text, chargeback_hold_minor::text, adjustment_minor::text, net_minor::text, status
      FROM fifo_settlement_batches WHERE id=$1::uuid
  `, [batchId]))[0];
  if (!b) return { ok: false, error: "batch not found" };
  if (b.status === "REJECTED") return { ok: false, error: "batch rejected" };

  const gst = BigInt(b.gst_minor), chargeback = BigInt(b.chargeback_hold_minor);
  const adj = BigInt(b.adjustment_minor), net = BigInt(b.net_minor);
  const orderNet = net + gst + chargeback - adj;   // amount debited from MERCHANT_PAYABLE

  const lines: any[] = [
    { account_code: `LIABILITIES.MERCHANT_PAYABLE.${b.merchant_id}`, account_type: "LIABILITY", side: "D", amount_minor: orderNet, currency: b.currency },
    { account_code: `LIABILITIES.SETTLEMENT_PAYABLE.${b.merchant_id}`, account_type: "LIABILITY", side: "C", amount_minor: net, currency: b.currency },
  ];
  if (gst > 0n) lines.push({ account_code: `LIABILITIES.GST_PAYABLE.PLATFORM`, account_type: "LIABILITY", side: "C", amount_minor: gst, currency: b.currency });
  if (chargeback > 0n) lines.push({ account_code: `LIABILITIES.CHARGEBACK_HOLD.${b.merchant_id}`, account_type: "LIABILITY", side: "C", amount_minor: chargeback, currency: b.currency });
  // Approved adjustment: positive = pay merchant more (platform expense); negative = claw back (platform income).
  if (adj > 0n) lines.push({ account_code: `EXPENSE.SETTLEMENT_ADJUSTMENT.PLATFORM`, account_type: "EXPENSE", side: "D", amount_minor: adj, currency: b.currency });
  else if (adj < 0n) lines.push({ account_code: `INCOME.SETTLEMENT_ADJUSTMENT.PLATFORM`, account_type: "INCOME", side: "C", amount_minor: -adj, currency: b.currency });

  let journalId: string | null = null;
  try {
    const j = await postJournal({
      journal_type: "settlement.batch",
      narration: `FIFO settlement ${b.batch_ref} (${b.order_count} orders)`,
      currency: b.currency, merchant_id: b.merchant_id,
      ref: { type: "settlement_batch", id: b.batch_ref },
      idempotency_key: `settlement.batch:${b.batch_ref}`,
      lines,
    });
    journalId = j.journal_id;
  } catch (e) { return { ok: false, error: (e as Error).message }; }

  await rows("fifo", `UPDATE fifo_settlement_batches SET status='SETTLED', journal_id=$2, settled_at=now() WHERE id=$1::uuid`, [batchId, journalId]).catch(() => {});

  // Mark the batch's orders SETTLED (lifecycle COMPLETED -> SETTLED).
  const orders = await rows<{ id: string }>("fifo", `SELECT id::text FROM fifo_orders WHERE settlement_batch_id=$1::uuid AND status='COMPLETED'`, [batchId]);
  for (const o of orders) await transition({ orderId: o.id, to: "SETTLED", actor, actorKind: "system", reason: `settled in ${b.batch_ref}` });

  return { ok: true, journal_id: journalId };
}

// Release the orders if a pending batch is rejected by the checker.
export async function rejectSettlementBatch(batchId: string): Promise<void> {
  await rows("fifo", `UPDATE fifo_settlement_batches SET status='REJECTED' WHERE id=$1::uuid`, [batchId]).catch(() => {});
  await rows("fifo", `UPDATE fifo_orders SET settlement_batch_id=NULL WHERE settlement_batch_id=$1::uuid`, [batchId]).catch(() => {});
}
