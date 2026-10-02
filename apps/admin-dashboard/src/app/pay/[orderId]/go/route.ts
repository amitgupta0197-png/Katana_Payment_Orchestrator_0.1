// GET /pay/{order id}/go — hand the customer's browser over to the page the order is paid on.
//
// Orders taken on a processor's own payment page carry that page's address in meta. It is never
// put in an API response (lib/merchant-safe): a merchant is given this Katana link instead, as
// `gateway_url` on the order and `checkout_url` on its status, and this route redirects to the
// real page. An order with no such page, or one already finished, goes to Katana's pay page.
// Public like the pay page itself: the order id in the URL is the capability.

import { NextResponse } from "next/server";
import { rows } from "@/lib/pg";
import { KATANA_TERMINAL } from "@/lib/katana-pay";
import { publicBase } from "@/lib/payin-providers/types";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

export async function GET(_req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const payPage = `${publicBase()}/pay/${encodeURIComponent(orderId)}`;
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return NextResponse.redirect(payPage, { status: 303, headers: noStore });

  const o = (await rows<{ status: string; url: string | null }>("vendorGateway", `
    SELECT status, meta->'gateway'->>'checkout_url' AS url
      FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'KATANA'
  `, [orderId]).catch(() => []))[0];

  const url = o && !KATANA_TERMINAL.has(o.status) && o.url && /^https?:\/\//i.test(o.url) ? o.url : null;
  return NextResponse.redirect(url ?? payPage, { status: 303, headers: noStore });
}
