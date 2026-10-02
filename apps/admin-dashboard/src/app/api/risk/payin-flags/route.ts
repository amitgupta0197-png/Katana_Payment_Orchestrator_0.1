// Pay-in compliance flags (lib/payin-compliance): transaction patterns found on live pay-ins.
//   GET /api/risk/payin-flags?status=OPEN&merchant=M10001   the flags, open ones first
// Staff only: a flag is about a merchant and is never shown to one.
import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { listComplianceFlags } from "@/lib/payin-compliance-store";
import { RULE_LABEL } from "@/lib/payin-compliance";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "RISK", "COMPLIANCE"]);
  if ("response" in g) return g.response;
  const sp = new URL(req.url).searchParams;
  try {
    const flags = await listComplianceFlags({ status: sp.get("status") ?? undefined, merchantId: sp.get("merchant") ?? undefined });
    return NextResponse.json({ flags: flags.map((f) => ({ ...f, label: RULE_LABEL[f.rule] })) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
