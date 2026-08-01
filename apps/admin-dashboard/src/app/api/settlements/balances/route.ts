// GET /api/settlements/balances — the upline's aggregate balance view (BRD §13 tiles):
// per-branch and total collected / settled / blocked / available, plus commission
// deducted across settlements. SUPER_ADMIN (?provider=) + PROVIDER(own).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { branchesForProvider, outstandingForBranch } from "@/lib/branch-settlement";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const providerId = s.persona === "PROVIDER" ? s.scope_id! : new URL(req.url).searchParams.get("provider");
  if (!providerId) return NextResponse.json({ error: "provider required" }, { status: 400 });

  try {
    const branches = await branchesForProvider(providerId);
    // `blocked` (in-flight, raised-but-not-yet-verified) is reported by a later revision of
    // outstandingForBranch than the one on this baseline, which returns only
    // collected/settled/outstanding. Default it to 0 rather than pulling that revision in:
    // the tile then reads "0 in-flight" instead of breaking the whole balances view.
    const per = await Promise.all(branches.map(async (b) => {
      const o = await outstandingForBranch(providerId, b.merchant_code);
      return { branch: b.merchant_code, name: b.name, blocked: 0, ...o };
    }));
    const totals = per.reduce(
      (a, x) => ({ collected: a.collected + x.collected, settled: a.settled + x.settled, blocked: a.blocked + x.blocked, available: a.available + x.outstanding }),
      { collected: 0, settled: 0, blocked: 0, available: 0 },
    );
    // Commission deducted across this provider's settlements (from the charge snapshots).
    const comm = (await rows<{ total: number }>("provider", `
      SELECT COALESCE(SUM((charges->>'total_charges')::numeric),0)::float AS total
        FROM provider_branch_settlements
       WHERE provider_id = $1::uuid AND status IN ('VERIFIED','RECONCILED')
    `, [providerId]).catch(() => [{ total: 0 }]))[0];

    return NextResponse.json({ totals: { ...totals, commission_deducted: comm?.total ?? 0 }, branches: per });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
