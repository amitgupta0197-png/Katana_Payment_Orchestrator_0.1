// POST /api/merchants/{id}/agent-pair — a one-time code (and QR link) that sets up a Katana Agent
// phone for this banker (lib/agent-pair). Staff: SUPER_ADMIN, ADMIN. The phone redeems it at
// POST /api/v1/agent/pair within 15 minutes; making a new code cancels the old one.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { pairLink, showPairCode } from "@/lib/agent-pair";
import { createPairCode } from "@/lib/agent-pair-store";
import { wormAppend } from "@/lib/worm";

export const dynamic = "force-dynamic";

const BASE = () => (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const m = (await rows<{ merchant_code: string }>("merchant",
      `SELECT merchant_code FROM merchants WHERE id::text = $1 OR merchant_code = $1 LIMIT 1`, [id]))[0];
    if (!m) return NextResponse.json({ error: "banker not found" }, { status: 404 });
    const { code, expires_at } = await createPairCode(m.merchant_code, g.session.email);
    wormAppend({ actorId: g.session.user_id, actorEmail: g.session.email, action: "merchant.agent_pair_code",
      resourceType: "merchant", resourceId: m.merchant_code, before: null, after: { expires_at } }).catch(() => {});
    return NextResponse.json({ code, shown: showPairCode(code), link: pairLink(BASE(), code), expires_at }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
