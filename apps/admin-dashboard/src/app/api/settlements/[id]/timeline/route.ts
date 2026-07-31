// GET /api/settlements/[id]/timeline — the immutable status history for one settlement.
// Read-access mirrors the settlement itself: the owning UPLINE (provider), the addressed
// DOWNLINE (branch), and ADMIN. Newest-last so the UI renders it top-to-bottom.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { branchKeysForMerchant } from "@/lib/provider-integration";

export const dynamic = "force-dynamic";

interface Event {
  id: string; action: string; from_status: string | null; to_status: string;
  actor: string | null; actor_role: string | null; remarks: string | null;
  details: Record<string, unknown>; created_at: string;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  try {
    const cur = (await rows<{ provider_id: string; merchant_key: string }>(
      "provider",
      `SELECT provider_id::text, merchant_key FROM provider_branch_settlements WHERE id = $1::uuid`, [id]))[0];
    if (!cur) return NextResponse.json({ error: "settlement not found" }, { status: 404 });

    if (s.persona === "PROVIDER" && s.scope_id !== cur.provider_id)
      return NextResponse.json({ error: "not your settlement" }, { status: 403 });
    if (s.persona === "MERCHANT") {
      const keys = await branchKeysForMerchant(s.scope_id!);
      if (!keys.includes(cur.merchant_key))
        return NextResponse.json({ error: "not your settlement" }, { status: 403 });
    }

    const events = await rows<Event>("provider", `
      SELECT id::text, action, from_status, to_status, actor, actor_role, remarks, details, created_at
        FROM provider_settlement_events
       WHERE settlement_id = $1::uuid
       ORDER BY created_at ASC
    `, [id]).catch(() => []);

    return NextResponse.json({ events });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
