// Persona policy (PRODUCT_VISION §3.8):
//   SUPER_ADMIN — C ✓ R ✓ U ✓ (release).
//   PROVIDER    — R mapped only.
//   MERCHANT    — R own only.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;

  try {
    const params: unknown[] = ["tenant-default"];
    let where = "tenant_id = $1";
    if (s.persona === "MERCHANT") {
      where += ` AND merchant_id = $${params.length + 1}`;
      params.push(s.scope_id);
    } else if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ reserves: [], stats: emptyStats() });
      where += ` AND merchant_id = ANY($${params.length + 1}::text[])`;
      params.push(ids);
    }
    const reserves = await rows<any>("ledger", `
      SELECT id, tenant_id, merchant_id, source_order_id, hold_amount, hold_percent_bps,
             held_at, release_date, release_status, released_amount, currency
        FROM reserve_ledger
       WHERE ${where}
       ORDER BY held_at DESC LIMIT 500
    `, params);
    return NextResponse.json({ reserves, stats: computeStats(reserves) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

function emptyStats() { return { total_held: 0, releasing_this_week: 0, released_mtd: 0 }; }
function computeStats(reserves: any[]) {
  const now = Date.now();
  const weekFromNow = now + 7 * 24 * 3600 * 1000;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  let total_held = 0, releasing_this_week = 0, released_mtd = 0;
  for (const r of reserves) {
    const held = Number(r.hold_amount ?? 0);
    const released = Number(r.released_amount ?? 0);
    if (r.release_status !== "RELEASED" && r.release_status !== "FORFEITED") total_held += held - released;
    if (r.release_date) {
      const rd = new Date(r.release_date).getTime();
      if (rd >= now && rd <= weekFromNow) releasing_this_week += held - released;
    }
    if (r.release_status === "RELEASED" && new Date(r.held_at).getTime() >= monthStart.getTime())
      released_mtd += released;
  }
  return { total_held, releasing_this_week, released_mtd };
}
