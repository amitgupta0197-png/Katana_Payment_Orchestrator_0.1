// "Test my integration" (lib/integration-dryrun-store): check a pasted order request the way the
// order API would, without creating an order or asking any gateway.
//   POST /api/portal/test-integration { text, mode?: "test" | "live" }
// Merchant and banker portals (only their own bankers' keys) and staff.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { PORTAL_PERSONAS } from "@/lib/portal-scope";
import { dryRunOrder } from "@/lib/integration-dryrun-store";

export const dynamic = "force-dynamic";

const schema = z.object({
  text: z.string().min(1).max(20_000),
  mode: z.enum(["test", "live"]).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const r = await dryRunOrder(g.session, body.text, body.mode ?? null);
    if ("limited" in r) return NextResponse.json({ error: "Too many checks this hour. Try again later.", code: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": "600" } });
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
