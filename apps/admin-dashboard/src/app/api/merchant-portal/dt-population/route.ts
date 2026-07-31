// GET /api/merchant-portal/dt-population — this merchant's own DT position: how much USDT
// advance it is carrying and how much it has repaid in incoming pay-in traffic.
//
// PROVIDER-gated and self-scoped: the session's scope_id is the providers.id, which we
// resolve to providers.code (what dt_purchases.payin_merchant_code stores). A merchant only
// ever sees its own numbers — never another merchant's, and never Katana's margin.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { rows } from "@/lib/pg";
import { payinPopulation } from "@/lib/dt-payin";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["PROVIDER"]);
  if ("response" in g) return g.response;
  const providerId = g.session.scope_id;
  if (!providerId) return NextResponse.json({ error: "PROVIDER session missing scope_id" }, { status: 400 });

  const [me] = await rows<{ code: string }>(
    "provider", `SELECT code FROM providers WHERE id = $1::uuid LIMIT 1`, [providerId],
  ).catch(() => []);
  // No provider row (or DT never assigned to it) → an all-zero position, not an error:
  // the dashboard tiles should render as "—" rather than break the page.
  if (!me?.code) return NextResponse.json({ population: null });

  const population = await payinPopulation({ payin_merchant_code: me.code });
  return NextResponse.json({ merchant_code: me.code, population });
}
