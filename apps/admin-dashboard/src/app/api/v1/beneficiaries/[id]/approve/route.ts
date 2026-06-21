// POST /api/v1/beneficiaries/[id]/approve — checker approves/rejects a beneficiary
// (maker-checker, BRD §9). Approval whitelists it for payouts.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { decideBeneficiary } from "@/lib/fifo-payout";

export const dynamic = "force-dynamic";

const schema = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "COMPLIANCE", "RISK"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try {
    const r = await decideBeneficiary(id, body.decision === "approve", g.session.email, body.reason);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true, status: body.decision === "approve" ? "APPROVED" : "REJECTED" });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
