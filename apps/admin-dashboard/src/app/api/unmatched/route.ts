// "Unmatched payments" (lib/unmatched-store): money captured with no order, and the orders it could be for.
//   GET /api/unmatched[?banker=CODE][&marked=1]
// Staff see every banker (or one); a merchant or banker login only its own bankers. The payer's UPI
// ID is masked for merchants, and no gateway is named.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { PORTAL_PERSONAS } from "@/lib/portal-scope";
import { listUnmatched } from "@/lib/unmatched-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  const q = new URL(req.url).searchParams;
  try {
    return NextResponse.json(await listUnmatched(g.session, { banker: q.get("banker"), showMarked: q.get("marked") === "1" }),
      { headers: { "Cache-Control": "no-store" } });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
