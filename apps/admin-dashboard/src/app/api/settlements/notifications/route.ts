// GET /api/settlements/notifications — the caller's recent settlement activity feed
// (BRD §7 dashboard notifications). Returns the latest timeline events across every
// settlement in the caller's scope, enriched with the request ref + amounts, so the
// dashboards can show "KTN-SET-000245 for ₹94,250 marked Paid · UTR …" and toast new
// ones as they arrive on the existing poll.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { branchKeysForMerchant } from "@/lib/provider-integration";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));

  const where: string[] = []; const args: unknown[] = [];
  try {
    if (s.persona === "PROVIDER") { args.push(s.scope_id); where.push(`e.provider_id = $${args.length}::uuid`); }
    else if (s.persona === "MERCHANT") {
      const keys = await branchKeysForMerchant(s.scope_id!);
      args.push(keys); where.push(`pbs.merchant_key = ANY($${args.length}::text[])`);
    }
    args.push(limit);

    const events = await rows("provider", `
      SELECT e.id::text, e.settlement_id::text, e.action, e.from_status, e.to_status,
             e.actor, e.actor_role, e.remarks, e.created_at,
             pbs.request_ref, pbs.merchant_key, pbs.net_amount::float AS net_amount,
             pbs.amount::float AS amount, pbs.settle_mode, pbs.utr, pbs.tx_hash
        FROM provider_settlement_events e
        JOIN provider_branch_settlements pbs ON pbs.id = e.settlement_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY e.created_at DESC
       LIMIT $${args.length}
    `, args);

    return NextResponse.json({ events });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
