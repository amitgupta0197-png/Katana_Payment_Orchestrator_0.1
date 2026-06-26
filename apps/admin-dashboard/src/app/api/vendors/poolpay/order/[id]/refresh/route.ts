// Admin "Force status refresh" — immediately re-resolve a single PoolPay order
// (final-status lock + sandbox decision + pending-expiry) instead of waiting for
// the background poller. SUPER_ADMIN / MERCHANT.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolvePoolPay, genRrn, POOLPAY_TERMINAL } from "@/lib/poolpay";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;

  try {
    const found = await rows<any>("vendorGateway", `
      SELECT id::text, status, amount, EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
        FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'POOLPAY'
    `, [id]);
    if (!found.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    const o = found[0];

    const amountMinor = Math.round(Number(o.amount) * 100);
    const d = resolvePoolPay(o.status, amountMinor, o.age_seconds);
    if (d.changed) {
      const rrn = d.status === "SUCCESS" ? genRrn(o.id) : null;
      await rows("vendorGateway", `
        UPDATE vendor_payin_orders SET status = $2, response_code = $3, rrn = COALESCE($4, rrn), updated_at = now()
         WHERE id = $1::uuid
      `, [id, d.status, d.response_code, rrn]);
    }
    return NextResponse.json({ ok: true, status: d.status, changed: d.changed, terminal: POOLPAY_TERMINAL.has(d.status) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
