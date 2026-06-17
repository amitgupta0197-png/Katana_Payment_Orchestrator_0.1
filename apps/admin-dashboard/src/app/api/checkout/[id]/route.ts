// Single order detail (Sprint 2 expanded): joins activity from audit_events,
// vendor callbacks, ledger journals, payment attempts, state transitions and
// the routing decision trace.

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
    const order = await rows<any>("checkout", `
      SELECT id::text, tenant_id, merchant_id, client_ref, txn_id, amount,
             COALESCE(amount_minor::text,'') AS amount_minor,
             currency, method, selected_rail, status,
             COALESCE(customer_email,'') AS customer_email,
             COALESCE(idempotency_key,'') AS idempotency_key, created_at
        FROM checkout_orders WHERE id::text = $1 OR txn_id = $1
       LIMIT 1
    `, [id]);
    if (!order.length) return NextResponse.json({ error: "not found" }, { status: 404 });

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

    const attempts = await rows<any>("checkout", `
      SELECT id::text, attempt_no, rail_provider AS provider, rail_method AS method,
             status, rail_ref AS provider_txn_id,
             COALESCE(auth_status,'') AS auth_status,
             COALESCE(next_state,'') AS next_state,
             COALESCE(error_code,'') AS error_code,
             COALESCE(error_message,'') AS error_message,
             COALESCE(response_time_ms,0) AS response_time_ms,
             started_at, completed_at
        FROM checkout_attempts WHERE order_id = $1::uuid
        ORDER BY attempt_no, started_at
    `, [order[0].id]).catch(() => []);

    const transitions = await rows<any>("checkout", `
      SELECT id::text, from_status, to_status, actor_kind, COALESCE(actor_id,'') AS actor_id,
             COALESCE(reason,'') AS reason, occurred_at
        FROM order_state_transitions WHERE order_id = $1::uuid
        ORDER BY occurred_at
    `, [order[0].id]).catch(() => []);

    const route = await rows<any>("routingEngine", `
      SELECT id::text, winner, score, selected_rank, cascade_ranks, factors,
             weights_applied, decided_at
        FROM routing_decisions WHERE order_id = $1::uuid OR txn_id = $2
        ORDER BY decided_at DESC LIMIT 1
    `, [order[0].id, order[0].txn_id]).catch(() => []);

    return NextResponse.json({
      order: order[0], events, callbacks, journals,
      attempts, transitions,
      route: route[0] ?? null,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
