// /api/me/live-activation — the signed-in banker's "Activate live mode" checklist.
//   GET  → status, checklist, whether it can be requested
//   POST → request activation (only once every checklist item is done)
//   MERCHANT only (own). See lib/live-activation.ts.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { ownMerchantCode } from "@/lib/merchant-keys";
import { activationState, requestActivation, activationErrorResponse } from "@/lib/live-activation";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;
  const code = await ownMerchantCode(g.session.scope_id);
  if (!code) return NextResponse.json({ error: "merchant not resolved" }, { status: 404 });
  try {
    return NextResponse.json(await activationState(code));
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function POST() {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;
  const code = await ownMerchantCode(g.session.scope_id);
  if (!code) return NextResponse.json({ error: "merchant not resolved" }, { status: 404 });
  try {
    return NextResponse.json(await requestActivation(code, g.session.email));
  } catch (err) {
    const a = activationErrorResponse(err);
    if (a) return NextResponse.json(a.body, { status: a.status });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
