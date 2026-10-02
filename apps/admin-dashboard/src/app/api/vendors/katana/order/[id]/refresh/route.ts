// Admin "Force status refresh" — immediately re-resolve a single Katana Pay order
// (final-status lock + sandbox decision + pending-expiry) instead of waiting for
// the background poller. SUPER_ADMIN / MERCHANT.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { orderInScope } from "@/lib/portal-scope";
import { resolveKatanaStatus, genRrn, KATANA_TERMINAL, autoResolvePaused } from "@/lib/katana-pay";
import { sendPayinCallback } from "@/lib/merchant-callback";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;

  try {
    const found = await rows<any>("vendorGateway", `
      SELECT id::text, status, amount, livemode, meta, merchant_id, EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
        FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'KATANA'
    `, [id]);
    // A banker login refreshes its own orders only (lib/portal-scope).
    if (!found.length || !(await orderInScope(g.session, found[0].merchant_id)))
      return NextResponse.json({ error: "not found" }, { status: 404 });
    const o = found[0];

    // A held order or one with a payment proof waits for a person (autoResolvePaused); a refresh
    // must not expire it any more than the poller does.
    if (autoResolvePaused(o.meta))
      return NextResponse.json({ ok: true, status: o.status, changed: false, terminal: KATANA_TERMINAL.has(o.status), held: true });

    const amountMinor = Math.round(Number(o.amount) * 100);
    const d = resolveKatanaStatus(o.status, amountMinor, o.age_seconds, o.livemode !== false);
    if (d.changed) {
      const rrn = d.status === "SUCCESS" ? genRrn(o.id) : null;
      // Never write over an order that became final since the read above.
      const moved = await rows<{ status: string }>("vendorGateway", `
        UPDATE vendor_payin_orders SET status = $2, response_code = $3, rrn = COALESCE($4, rrn), updated_at = now()
         WHERE id = $1::uuid AND status NOT IN ('SUCCESS','SUCCEEDED','FAILED','EXPIRED')
        RETURNING status
      `, [id, d.status, d.response_code, rrn]);
      if (!moved.length) {
        const now = (await rows<{ status: string }>("vendorGateway",
          `SELECT status FROM vendor_payin_orders WHERE id = $1::uuid`, [id]))[0]?.status ?? o.status;
        return NextResponse.json({ ok: true, status: now, changed: false, terminal: KATANA_TERMINAL.has(now) });
      }
      // The refresh just made the order final, so the merchant is told, as on every other path.
      if (KATANA_TERMINAL.has(d.status)) sendPayinCallback(id).catch(() => {});
    }
    return NextResponse.json({ ok: true, status: d.status, changed: d.changed, terminal: KATANA_TERMINAL.has(d.status) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
