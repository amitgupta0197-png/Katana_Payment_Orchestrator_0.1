// GET /pay/{order id}/go — hand the customer's browser over to the page the order is paid on.
//
// Orders taken on a processor's own payment page carry that page's address in meta. It is never
// put in an API response (lib/merchant-safe): a merchant is given this Katana link instead, as
// `gateway_url` on the order and `checkout_url` on its status, and this route redirects to the
// real page. An order with no such page, one already finished, or one whose time to pay is over
// (it is only waiting to be confirmed: inConfirmWindow) goes to Katana's pay page.
// Public like the pay page itself: the order id in the URL is the capability.

import { NextResponse } from "next/server";
import { rows } from "@/lib/pg";
import { KATANA_TERMINAL, inConfirmWindow } from "@/lib/katana-pay";
import { publicBase } from "@/lib/payin-providers/types";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

export async function GET(_req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const payPage = `${publicBase()}/pay/${encodeURIComponent(orderId)}`;
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return NextResponse.redirect(payPage, { status: 303, headers: noStore });

  const o = (await rows<{ status: string; url: string | null; provider: string | null; livemode: boolean; age_seconds: number }>("vendorGateway", `
    SELECT status, meta->'gateway'->>'checkout_url' AS url, meta->'gateway'->>'provider' AS provider, livemode,
           EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
      FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'KATANA'
  `, [orderId]).catch(() => []))[0];

  const payable = o && !KATANA_TERMINAL.has(o.status)
    && !inConfirmWindow(o.status, o.age_seconds, { gateway: { provider: o.provider } }, o.livemode !== false);
  const url = o && payable && o.url && /^https?:\/\//i.test(o.url) ? o.url : null;
  return NextResponse.redirect(url ?? payPage, { status: 303, headers: noStore });
}
