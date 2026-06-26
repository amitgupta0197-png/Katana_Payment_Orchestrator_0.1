// Universal transactions — one normalized list across every channel
// (checkout_orders + vendor_payin_orders) in the canonical §4 shape.
//   SUPER_ADMIN — all; PROVIDER — scoped to mapped merchants; MERCHANT — own.
//
// Query params: ?status=SUCCESS&provider=POOLPAY&merchant=M-KUSH&q=<search>

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { checkoutToUniversal, payinToUniversal, normalizeStatus, type UniversalTxn } from "@/lib/universal-txn";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);
  const fStatus = url.searchParams.get("status");
  const fProvider = url.searchParams.get("provider");
  const fMerchant = url.searchParams.get("merchant");
  const q = (url.searchParams.get("q") || "").toLowerCase();

  try {
    // Resolve the merchant_code scope for the caller.
    let codes: string[] | null = null; // null = no filter (super-admin)
    if (s.persona === "MERCHANT") codes = s.scope_id ? [s.scope_id] : [];
    else if (s.persona === "PROVIDER") codes = await resolveProviderMerchants(s);
    if (codes && !codes.length) return NextResponse.json({ transactions: [], total: 0 });

    const scoped = codes !== null;
    const checkout = await rows<any>("checkout", `
      SELECT id::text, merchant_id, amount, currency, status, method, txn_id,
             COALESCE(NULLIF(selected_rail,''),'DIRECT') AS selected_rail, created_at
        FROM checkout_orders
       ${scoped ? "WHERE merchant_id = ANY($1::text[])" : ""}
       ORDER BY created_at DESC LIMIT 1000
    `, scoped ? [codes] : []).catch(() => []);

    const payin = await rows<any>("vendorGateway", `
      SELECT id::text, merchant_id, amount, currency_code, status, channel, vendor,
             vendor_txn_id, COALESCE(rrn,'') AS rrn, COALESCE(sub_mid_code,'') AS sub_mid_code, created_at
        FROM vendor_payin_orders
       ${scoped ? "WHERE merchant_id = ANY($1::text[])" : "WHERE merchant_id IS NOT NULL"}
       ORDER BY created_at DESC LIMIT 1000
    `, scoped ? [codes] : []).catch(() => []);

    let txns: UniversalTxn[] = [...checkout.map(checkoutToUniversal), ...payin.map(payinToUniversal)];

    if (fStatus) { const want = normalizeStatus(fStatus); txns = txns.filter((t) => t.status === want); }
    if (fProvider) txns = txns.filter((t) => t.provider.toUpperCase() === fProvider.toUpperCase());
    if (fMerchant) txns = txns.filter((t) => t.merchant_id === fMerchant);
    if (q) txns = txns.filter((t) =>
      t.katana_order_id.toLowerCase().includes(q) || (t.provider_txn_id || "").toLowerCase().includes(q) ||
      (t.utr || "").toLowerCase().includes(q) || t.merchant_id.toLowerCase().includes(q) ||
      (t.sub_mid || "").toLowerCase().includes(q));

    txns.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
    return NextResponse.json({ transactions: txns.slice(0, 500), total: txns.length });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
