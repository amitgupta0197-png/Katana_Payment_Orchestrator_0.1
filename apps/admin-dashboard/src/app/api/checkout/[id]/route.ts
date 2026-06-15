// Single order detail — joins activity from audit_events scoped by resource_id.
import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  try {
    // id is uuid, txn_id is varchar. Cast id to text so both comparisons are varchar.
    const order = await rows<any>("checkout", `
      SELECT id::text, tenant_id, merchant_id, client_ref, txn_id, amount, currency,
             method, selected_rail, status, COALESCE(customer_email,'') AS customer_email,
             COALESCE(idempotency_key,'') AS idempotency_key, created_at
        FROM checkout_orders WHERE id::text = $1 OR txn_id = $1
       LIMIT 1
    `, [id]);
    if (!order.length) return NextResponse.json({ error: "not found" }, { status: 404 });

    // Scope check.
    if (s.persona === "MERCHANT" && order[0].merchant_id !== s.scope_id)
      return NextResponse.json({ error: "order not owned by your merchant" }, { status: 403 });
    if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.includes(order[0].merchant_id))
        return NextResponse.json({ error: "order's merchant not mapped to your provider" }, { status: 403 });
    }

    const events = await rows<any>("audit", `
      SELECT event_id::text, actor_subject, actor_type, action, occurred_at, metadata
        FROM audit_events WHERE resource_type = 'checkout_order' AND resource_id = $1
       ORDER BY occurred_at DESC LIMIT 100
    `, [order[0].id]).catch(() => []);

    // vendor_callbacks actual cols: id, vendor, kind, received_at, order_id, vendor_txn_id,
    // signature_ok, body, processed, process_error.
    const callbacks = await rows<any>("vendorGateway", `
      SELECT id::text, vendor, kind, received_at,
             COALESCE(vendor_txn_id,'') AS vendor_txn_id,
             signature_ok, processed, COALESCE(process_error,'') AS process_error
        FROM vendor_callbacks WHERE order_id = $1
       ORDER BY received_at DESC LIMIT 50
    `, [order[0].id]).catch(() => []);

    const journals = await rows<any>("ledger", `
      SELECT id::text, posted_at, narration, currency, ref_type, ref_id
        FROM journal_entries WHERE ref_id = $1 ORDER BY posted_at DESC LIMIT 50
    `, [order[0].id]).catch(() => []);

    return NextResponse.json({ order: order[0], events, callbacks, journals });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
