// /api/merchants/[id]/live-activation — a banker's "Activate live mode" state, for operators.
//   GET  → status + checklist. SUPER_ADMIN any; PROVIDER only for mapped merchants.
//   POST { decision: "APPROVE" | "REJECT", reason? } → SUPER_ADMIN only. A reason is required to
//        reject; approving may override an incomplete checklist. See lib/live-activation.ts.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";
import { activationState, decideActivation, activationErrorResponse } from "@/lib/live-activation";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;
  try {
    return NextResponse.json(await activationState(scope.code));
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().max(500).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    return NextResponse.json(await decideActivation(scope.code, body.decision, g.session.email, body.reason));
  } catch (err) {
    const a = activationErrorResponse(err);
    if (a) return NextResponse.json(a.body, { status: a.status });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
