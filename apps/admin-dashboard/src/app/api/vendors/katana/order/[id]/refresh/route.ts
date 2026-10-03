// Admin "Force status refresh" — immediately re-resolve a single Katana Pay order
// (final-status lock + sandbox decision + pending-expiry) instead of waiting for
// the background poller. SUPER_ADMIN / MERCHANT.
//
// A gateway order is settled by its gateway alone, so for one that is not paid the gateway is
// asked first — also when the order is EXPIRED or FAILED, which a confirmed payment revives
// (lib/katana-order). When nothing changes, `note` says what the gateway answered.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { orderInScope } from "@/lib/portal-scope";
import {
  resolveKatanaStatus, orderExpirySeconds, genRrn, KATANA_TERMINAL, autoResolvePaused, gatewayCheckNote, GATEWAY_CHECK_NOTE_MERCHANT,
} from "@/lib/katana-pay";
import { sendPayinCallback } from "@/lib/merchant-callback";
import { checkPayuPayinNow } from "@/lib/payu-result";
import { checkGatewayPayin } from "@/lib/gateway-payin";
import { seesGatewayNames } from "@/lib/merchant-safe";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "MERCHANT"]);
  if ("response" in g) return g.response;
  const staff = seesGatewayNames(g.session.persona);
  const { id } = await params;

  try {
    const read = () => rows<any>("vendorGateway", `
      SELECT id::text, status, amount, livemode, meta, vendor_txn_id, merchant_id,
             EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
        FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'KATANA'
    `, [id]);
    const found = await read();
    // A banker login refreshes its own orders only (lib/portal-scope).
    if (!found.length || !(await orderInScope(g.session, found[0].merchant_id)))
      return NextResponse.json({ error: "not found" }, { status: 404 });
    let o = found[0];

    // Staff ask the gateway outright: no throttle, and past the sweep's re-check window
    // (GATEWAY_RECHECK_SQL), which is when an order can no longer settle on its own. A merchant
    // session is held to the pay page's throttle and never sees the gateway's name or words.
    let note: string | undefined;
    const provider = o.meta?.gateway?.provider;
    if (provider && o.livemode !== false && o.status !== "SUCCESS" && o.status !== "SUCCEEDED") {
      const payuKeySalt = provider === "PAYU" && o.meta?.gateway?.auth !== "client_credentials";
      const r = payuKeySalt
        ? await checkPayuPayinNow(o.vendor_txn_id, o.merchant_id, staff ? null : 4)
        : await checkGatewayPayin({
            provider, txnid: o.vendor_txn_id, merchantCode: o.merchant_id, source: "staff_refresh",
            throttleSec: staff ? undefined : 4,
          });
      if (r.applied) {
        const now = (await read())[0]?.status ?? o.status;
        return NextResponse.json({ ok: true, status: now, changed: now !== o.status, terminal: KATANA_TERMINAL.has(now), gateway_checked: true });
      }
      note = staff ? gatewayCheckNote(r) : GATEWAY_CHECK_NOTE_MERCHANT;
      o = (await read())[0] ?? o;   // another channel may have settled it while the gateway was asked
    }

    // A held order or one with a payment proof waits for a person (autoResolvePaused); a refresh
    // must not expire it any more than the poller does.
    if (autoResolvePaused(o.meta))
      return NextResponse.json({ ok: true, status: o.status, changed: false, terminal: KATANA_TERMINAL.has(o.status), held: true, ...(note ? { note } : {}) });

    const amountMinor = Math.round(Number(o.amount) * 100);
    const live = o.livemode !== false;
    const d = resolveKatanaStatus(o.status, amountMinor, o.age_seconds, live, orderExpirySeconds(o.meta, live));
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
        return NextResponse.json({ ok: true, status: now, changed: false, terminal: KATANA_TERMINAL.has(now), ...(note ? { note } : {}) });
      }
      // The refresh just made the order final, so the merchant is told, as on every other path.
      if (KATANA_TERMINAL.has(d.status)) sendPayinCallback(id).catch(() => {});
    }
    return NextResponse.json({ ok: true, status: d.status, changed: d.changed, terminal: KATANA_TERMINAL.has(d.status), ...(note ? { note } : {}) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
