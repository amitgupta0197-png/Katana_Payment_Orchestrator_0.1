// POST /api/v1/orders/[id]/action — operator processes a queue item
// (BRD §15 steps 10-15, §16). accept → process → complete | reject | hold.
// On PAY-IN complete, posts to the ledger so it flows into settlement.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { operatorForUser, transition, settlePayinToLedger, findDuplicateUtr, recordFraudAlert } from "@/lib/fifo";
import { settlePayoutToLedger } from "@/lib/fifo-payout";

export const dynamic = "force-dynamic";

const schema = z.object({
  action: z.enum(["accept", "process", "complete", "reject", "hold"]),
  utr: z.string().optional(),
  tx_hash: z.string().optional(),
  reason: z.string().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["OPERATOR", "SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  try {
    const o = (await rows<any>("fifo", `
      SELECT id::text, order_ref, merchant_id, direction, amount_minor::text, currency, settlement_mode, status, txn_ref
        FROM fifo_orders WHERE order_ref=$1 OR id::text=$1 LIMIT 1
    `, [id]))[0];
    if (!o) return NextResponse.json({ error: "order not found" }, { status: 404 });

    // Only the assigned operator (or an admin) may act on the item.
    const opId = await operatorForUser(s.email, s.full_name, s.user_id);
    const q = (await rows<any>("fifo", `SELECT assigned_to::text FROM fifo_queue WHERE order_id=$1::uuid`, [o.id]))[0];
    const isAdmin = s.persona === "SUPER_ADMIN" || s.persona === "ADMIN";
    if (!isAdmin && q && q.assigned_to !== opId) return NextResponse.json({ error: "not your assignment" }, { status: 403 });

    const actor = s.email, actorKind = "operator";

    if (body.action === "accept") {
      const r = await transition({ orderId: o.id, to: "ACCEPTED", actor, actorKind, reason: "accepted within SLA" });
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
      await rows("fifo", `UPDATE fifo_queue SET status='ACCEPTED', accepted_at=now() WHERE order_id=$1::uuid`, [o.id]).catch(() => {});
      return NextResponse.json({ ok: true, status: "ACCEPTED" });
    }
    if (body.action === "process") {
      const r = await transition({ orderId: o.id, to: "PROCESSING", actor, actorKind, reason: "processing started" });
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
      return NextResponse.json({ ok: true, status: "PROCESSING" });
    }
    if (body.action === "complete") {
      // USDT transfers must carry an on-chain tx_hash to close (BRD §11.C, FR-008).
      if (o.settlement_mode === "USDT" && !body.tx_hash) {
        return NextResponse.json({ error: "tx_hash required to complete a USDT settlement" }, { status: 400 });
      }
      // Duplicate-UTR guard (BRD §24, AC-008): the same bank UTR cannot close two
      // orders. Auto-HOLD the second one and raise a fraud alert instead.
      if (body.utr) {
        const dup = await findDuplicateUtr(o.id, body.utr);
        if (dup) {
          await transition({ orderId: o.id, to: "HOLD", actorKind: "system", reason: `duplicate UTR ${body.utr} (already on ${dup.order_ref})` });
          await recordFraudAlert({
            orderId: o.id, orderRef: o.order_ref, merchantId: o.merchant_id, type: "DUPLICATE_UTR", severity: "CRITICAL",
            detail: `UTR ${body.utr} already attached to ${dup.order_ref} (${dup.status})`,
            payload: { utr: body.utr, conflict_order_ref: dup.order_ref, conflict_status: dup.status },
          });
          return NextResponse.json({ error: `duplicate UTR — already used on ${dup.order_ref}; order placed on HOLD`, held: true }, { status: 409 });
        }
      }
      const r = await transition({ orderId: o.id, to: "COMPLETED", actor, actorKind, reason: "completed by operator", payload: { utr: body.utr, tx_hash: body.tx_hash } });
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
      await rows("fifo", `UPDATE fifo_orders SET utr=COALESCE($2,utr), tx_hash=COALESCE($3,tx_hash) WHERE id=$1::uuid`, [o.id, body.utr ?? null, body.tx_hash ?? null]).catch(() => {});
      await rows("fifo", `UPDATE fifo_queue SET status='DONE' WHERE order_id=$1::uuid`, [o.id]).catch(() => {});
      let journalId: string | null = null;
      if (o.direction === "PAYIN") {
        journalId = await settlePayinToLedger({ merchantId: o.merchant_id, txnRef: o.txn_ref, amountMinor: BigInt(o.amount_minor), currency: o.currency, provider: o.settlement_mode });
      } else if (o.direction === "PAYOUT") {
        journalId = await settlePayoutToLedger({ merchantId: o.merchant_id, txnRef: o.txn_ref, amountMinor: BigInt(o.amount_minor), currency: o.currency, provider: o.settlement_mode });
      }
      return NextResponse.json({ ok: true, status: "COMPLETED", journal_id: journalId });
    }
    if (body.action === "reject") {
      const r = await transition({ orderId: o.id, to: "REJECTED", actor, actorKind, reason: body.reason ?? "rejected by operator" });
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
      await rows("fifo", `UPDATE fifo_queue SET status='CANCELLED' WHERE order_id=$1::uuid`, [o.id]).catch(() => {});
      return NextResponse.json({ ok: true, status: "REJECTED" });
    }
    // hold → escalate to risk
    const r = await transition({ orderId: o.id, to: "HOLD", actor, actorKind, reason: body.reason ?? "escalated to risk" });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true, status: "HOLD" });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
