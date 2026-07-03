// /api/settlements/outstanding?provider=<id>&branch=<merchant_code>
// Outstanding receivable for a (provider, branch): collected SUCCESS pay-ins minus
// already-verified settlements. Prefills the "raise settlement" amount.
//   SUPER_ADMIN + PROVIDER(own).

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { outstandingForBranch } from "@/lib/branch-settlement";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);
  const branch = url.searchParams.get("branch");
  const providerId = s.persona === "PROVIDER" ? s.scope_id! : url.searchParams.get("provider");
  if (!providerId || !branch) return NextResponse.json({ error: "provider and branch required" }, { status: 400 });

  try {
    const o = await outstandingForBranch(providerId, branch);
    return NextResponse.json({ provider_id: providerId, branch, ...o });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
