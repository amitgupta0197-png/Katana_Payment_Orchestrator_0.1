// A merchant's PoolPay pay-in orders for the merchant-module operations view:
// which payments are currently active, their mode (QR/non-QR), active receiver
// VPA and backup-pool health. SUPER_ADMIN/PROVIDER (scoped)/MERCHANT (own).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;

  try {
    const orders = await rows<any>("vendorGateway", `
      SELECT id::text, order_id, vendor, amount::float AS amount, currency_code, status,
             COALESCE(rrn,'') AS rrn, COALESCE(sub_mid_code,'') AS sub_mid_code,
             meta, created_at
        FROM vendor_payin_orders
       WHERE merchant_id = $1
       ORDER BY created_at DESC LIMIT 100
    `, [scope.code]).catch(() => []);

    const shaped = orders.map((o: any) => {
      const m = o.meta ?? {};
      const pool = Array.isArray(m.vpa_pool) ? m.vpa_pool : [];
      return {
        id: o.id, order_id: o.order_id, vendor: o.vendor, amount: o.amount, currency_code: o.currency_code,
        status: o.status, rrn: o.rrn, sub_mid_code: o.sub_mid_code, created_at: o.created_at,
        mode: m.mode ?? "QR",
        active_vpa: m.receiver_vpa ?? null,
        vpa_total: pool.length,
        vpa_remaining: pool.filter((p: any) => p.status === "READY").length,
        terminal: ["SUCCESS", "SUCCEEDED", "FAILED", "EXPIRED"].includes(o.status),
      };
    });
    const live = shaped.filter((o: any) => !o.terminal);
    return NextResponse.json({ merchant_code: scope.code, live, all: shaped });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
