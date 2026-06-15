// Persona policy (PRODUCT_VISION §3.5):
//   SUPER_ADMIN — R all.
//   PROVIDER    — R mapped merchants only.
//   MERCHANT    — C ✓ own, R own only.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

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
      SELECT id, tenant_id, merchant_id, client_ref, txn_id, amount, currency,
             method, selected_rail, status, created_at
        FROM checkout_orders
       WHERE ${where}
       ORDER BY created_at DESC LIMIT ${limit}
    `, params);
    return NextResponse.json({ orders });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  client_ref: z.string().min(1).max(120),
  amount: z.number().positive(),
  currency: z.string().default("INR"),
  method: z.enum(["UPI_INTENT","UPI_COLLECT","CARD","NET_BANKING","WALLET","QR","CRYPTO"]),
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
  try {
    const merchantId = s.persona === "MERCHANT" ? s.scope_id : "tenant-default";
    const res = await rows<any>("checkout", `
      INSERT INTO checkout_orders (tenant_id, merchant_id, client_ref, amount, currency, method, status)
      VALUES ('tenant-default', $1, $2, $3, $4, $5, 'INITIATED')
      RETURNING id, client_ref, amount, currency, method, status, created_at
    `, [merchantId, body.client_ref, body.amount, body.currency, body.method]);
    return NextResponse.json(res[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
