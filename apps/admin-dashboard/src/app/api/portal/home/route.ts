// GET /api/portal/home: the merchant or banker portal's Home (lib/portal-home), for the mode the
// portal is switched to. Merchant (PROVIDER) and banker (MERCHANT) logins only.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { getLivemode } from "@/lib/mode";
import { homeData } from "@/lib/portal-home";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  try {
    const d = await homeData(g.session, await getLivemode());
    if (!d) return NextResponse.json({ error: "no account" }, { status: 404 });
    return NextResponse.json(d);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
