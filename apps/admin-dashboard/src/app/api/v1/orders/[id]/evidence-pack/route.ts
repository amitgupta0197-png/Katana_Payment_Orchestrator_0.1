// GET /api/v1/orders/[id]/evidence-pack — assemble the forensic evidence pack
// for an order (BRD §25, FR-010, §30). Compliance/Risk/Admin only.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { buildEvidencePack } from "@/lib/fifo-forensics";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "COMPLIANCE", "RISK", "FINANCE"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const pack = await buildEvidencePack(id, g.session.email);
    if (!pack) return NextResponse.json({ error: "order not found" }, { status: 404 });
    return NextResponse.json({ pack });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
