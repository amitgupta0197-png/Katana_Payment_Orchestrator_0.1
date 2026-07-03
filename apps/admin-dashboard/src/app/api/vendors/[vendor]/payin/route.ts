// SUPER_ADMIN only — per-vendor payin order browser.
import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ vendor: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { vendor } = await params;
  try {
    const orders = await rows<any>("vendorGateway", `
      SELECT id::text, tenant_id, vendor, pay_id, order_id, amount, currency_code,
             channel, COALESCE(vendor_txn_id,'') AS vendor_txn_id,
             COALESCE(rrn,'') AS rrn, response_code, status,
             COALESCE(merchant_id,'') AS merchant_id, COALESCE(sub_mid_code,'') AS sub_mid_code,
             COALESCE(meta->>'review','') AS review,
             COALESCE(meta->'proof'->>'utr','') AS proof_utr,
             COALESCE(meta->'confirmation'->>'evidence','') AS confirm_evidence,
             created_at
        FROM vendor_payin_orders WHERE upper(vendor) = upper($1)
       ORDER BY created_at DESC LIMIT 200
    `, [vendor]).catch(() => []);
    const credentials = await rows<any>("vendorGateway", `
      SELECT id::text, vendor, env, COALESCE(pay_id,'') AS pay_id, active, created_at
        FROM vendor_credentials WHERE upper(vendor) = upper($1)
       ORDER BY env DESC LIMIT 10
    `, [vendor]).catch(() => []);
    return NextResponse.json({ orders, credentials });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
