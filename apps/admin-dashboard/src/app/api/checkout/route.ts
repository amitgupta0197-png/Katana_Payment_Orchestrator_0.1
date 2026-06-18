// Persona policy (BRD §7 P3 + PRODUCT_VISION §3.5):
//   SUPER_ADMIN — R all, C ✓ (on behalf of merchant).
//   PROVIDER    — R mapped merchants only.
//   MERCHANT    — C ✓ own, R own only.
//
// POST delegates to lib/checkout-core.runCheckout() (shared with /api/pay, the
// merchant-signed entry point). The full lifecycle — idempotency, risk, SCA,
// routing, adapter charge, gateway signing, ledger, webhooks — lives there.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { runCheckout } from "@/lib/checkout-core";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);

  try {
    const params: unknown[] = ["tenant-default"];
    let where = "tenant_id = $1";
    if (s.persona === "MERCHANT") {
      where += ` AND merchant_id = $${params.length + 1}`;
      params.push(s.scope_id);
    } else if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ orders: [] });
      where += ` AND merchant_id = ANY($${params.length + 1}::text[])`;
      params.push(ids);
    }
    if (status) { where += ` AND status = $${params.length + 1}`; params.push(status); }

    const orders = await rows<any>("checkout", `
      SELECT id, tenant_id, merchant_id, client_ref, txn_id, amount, amount_minor::text,
             currency, method, selected_rail, status, created_at
        FROM checkout_orders
       WHERE ${where}
       ORDER BY created_at DESC LIMIT ${limit}
    `, params);
    return NextResponse.json({ orders });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  client_ref: z.string().min(1).max(120),
  amount: z.union([z.number().positive(), z.string()]),
  currency: z.string().default("INR"),
  method: z.enum(["UPI_INTENT","UPI_COLLECT","CARD","NETBANKING","WALLET","QR","CRYPTO"]),
  customer_email: z.string().email().optional(),
  idempotency_key: z.string().min(1).max(120).optional(),
  risk_score: z.number().min(0).max(1).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  if (s.persona === "MERCHANT" && !s.scope_id)
    return NextResponse.json({ error: "merchant session missing scope" }, { status: 403 });

  let body;
  try { body = createSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const merchantId = s.persona === "MERCHANT" ? s.scope_id! : "tenant-default";

  try {
    const r = await runCheckout({ merchantId, actorId: s.user_id, order: body });
    return NextResponse.json(r.body, { status: r.httpStatus });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
