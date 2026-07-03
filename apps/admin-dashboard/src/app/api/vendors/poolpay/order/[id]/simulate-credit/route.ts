// POST /api/vendors/poolpay/order/:id/simulate-credit — cockpit/merchant demo helper
// (SUPER_ADMIN / PROVIDER / MERCHANT). Sandbox has no Android agent yet, so this
// builds a realistic bank-credit alert FROM the order (amount + payee VPA + a fresh
// UTR — but NOT the order id) and runs it through the SAME reconciler the public
// /api/v1/txn-alert ingestion uses. So it exercises the real match-and-confirm path:
// the alert is matched back to this pending order by amount + payee VPA + recency and
// the order is auto-confirmed — flipping the customer pay page to "Payment received".

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { genRrn, POOLPAY_TERMINAL } from "@/lib/poolpay";
import { ingestTxnAlert } from "@/lib/txn-reconcile";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;

  try {
    const cur = await rows<any>("vendorGateway",
      `SELECT id::text, order_id, amount::float AS amount, status, meta FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'POOLPAY'`, [id]);
    if (!cur.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    const order = cur[0];
    if (POOLPAY_TERMINAL.has(order.status))
      return NextResponse.json({ error: `order already ${order.status}` }, { status: 409 });

    const meta = order.meta ?? {};
    const payee = meta.receiver_vpa ?? null;
    const utr = genRrn(order.id);
    const r = await ingestTxnAlert({
      source: "SIMULATED",
      device_id: "sim-device-01",
      bank: "HDFC",
      direction: "CREDIT",
      amount: order.amount,
      utr,
      payer_vpa: meta.sender_vpa ?? order.customer_vpa ?? "payer@upi",
      payee_vpa: payee,
      narration: `UPI/CR/${utr}/${payee ?? "settlement"}`,
      raw: `Rs.${Number(order.amount).toFixed(2)} credited to ${payee ?? "A/c"} UPI Ref ${utr}`,
    });
    return NextResponse.json({ simulated: true, ...r });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
