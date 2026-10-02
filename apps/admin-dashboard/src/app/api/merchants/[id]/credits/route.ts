// GET /api/merchants/[id]/credits — the UPI credits this banker's agent phone captured, for
// the banker detail page.
//
// That page's Transactions table lists pay-in ORDERS. A payment made straight to the banker's
// QR has no order, so it is stored (vendor_txn_alerts) and shown nowhere on the page — the
// agent looks broken while it is working. This is the same feed the banker's own portal reads
// (/api/banker-portal/credits), scoped by the banker in the URL instead of by the session.
//
// SUPER_ADMIN / PROVIDER (own bankers) / MERCHANT, as for payin-orders. Only what the list
// renders is returned: the capture's free-form `details` blob stays behind the banker portal.
import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";
import { IS_COLLECTION } from "@/lib/settlement-credit";
import { paymentAppOf } from "@/lib/payment-app";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;

  try {
    // Live credits only, and ordered by when the money arrived rather than when we heard
    // about it — both for the reasons given in /api/banker-portal/credits.
    const credits = await rows<any>("vendorGateway", `
      SELECT id::text, source, bank, sender, amount::float AS amount, COALESCE(utr,'') AS utr,
             COALESCE(payer_name,'') AS payer_name, outcome,
             COALESCE(matched_order_ref,'') AS matched_order_ref,
             COALESCE(event_time, created_at) AS received_at, created_at
        FROM vendor_txn_alerts
       WHERE direction = 'CREDIT' AND livemode = true AND merchant_id = $1
         AND ${IS_COLLECTION}
       ORDER BY COALESCE(event_time, created_at) DESC LIMIT 100
    `, [scope.code]);

    return NextResponse.json({
      merchant_code: scope.code,
      credits: credits.map(({ bank, sender, source, ...c }: any) => ({
        ...c, source, app: paymentAppOf({ bank, sender, source }).label,
      })),
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
