// One transaction, in full — the order, what the gateway said about it, and how it
// got to its current status. This is the detail behind a row on the transactions
// page, and deliberately mirrors what the gateway's own dashboard shows so a
// merchant never has to log into two places to answer "did this payment land?".
//
// PROVIDER only, scoped to the provider's own merchants. A provider asking for an
// order that is not theirs gets 404, not 403 — an existence check is information too.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["PROVIDER", "SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  // The transactions list keys checkout rows on the order UUID, but a merchant
  // chasing a payment usually has their own txn_id in hand. Accept either.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  try {
    const codes = await resolveProviderMerchants(s);
    const scoped = s.persona === "PROVIDER";
    if (scoped && !codes.length) return NextResponse.json({ error: "not found" }, { status: 404 });

    const order = (await rows<any>("checkout", `
      SELECT id::text, merchant_id, client_ref, txn_id, amount::float AS amount,
             currency, method, selected_rail, status, customer_email,
             idempotency_key, created_at, client_surl, client_furl
        FROM checkout_orders
       WHERE ${isUuid ? "id = $1::uuid" : "txn_id = $1"}
         ${scoped ? "AND merchant_id = ANY($2::text[])" : ""}
       LIMIT 1
    `, scoped ? [id, codes] : [id]).catch(() => []))[0];

    if (!order) return NextResponse.json({ error: "not found" }, { status: 404 });

    const detail = (await rows<any>("checkout", `
      SELECT provider, provider_payment_id, bank_ref_num, payment_type, bank_name,
             card_masked, card_network, name_on_card, vpa,
             amount::float AS amount, net_amount_debit::float AS net_amount_debit,
             gateway_fee::float AS gateway_fee, gateway_tax::float AS gateway_tax,
             settlement_amount::float AS settlement_amount, discount::float AS discount,
             customer_name, customer_email, customer_phone,
             gateway_status, error_code, error_message, udf,
             source, hash_verified, captured_at, updated_at
        FROM payment_details WHERE order_id = $1::uuid
    `, [order.id]).catch(() => []))[0] ?? null;

    const timeline = await rows<any>("checkout", `
      SELECT from_status, to_status, actor_kind, reason, payload, occurred_at
        FROM order_state_transitions
       WHERE order_id = $1::uuid
       ORDER BY occurred_at ASC
    `, [order.id]).catch(() => []);

    return NextResponse.json({ order, detail, timeline });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
