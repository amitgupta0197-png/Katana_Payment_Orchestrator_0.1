// /api/settlements/[id]/utr — the BRANCH submits the UTR after paying the
// provider's beneficiary account. Moves status REQUESTED/REJECTED → UTR_SUBMITTED
// so the provider can see and verify it (near-real-time).
//   SUPER_ADMIN + MERCHANT(own branch).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { branchKeysForMerchant } from "@/lib/provider-integration";

export const dynamic = "force-dynamic";

const schema = z.object({ utr: z.string().min(4).max(64), note: z.string().max(500).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    const cur = (await rows<any>("provider",
      `SELECT id::text, merchant_key, status FROM provider_branch_settlements WHERE id = $1::uuid`, [id]))[0];
    if (!cur) return NextResponse.json({ error: "settlement not found" }, { status: 404 });

    // Branch may only submit on settlements addressed to it.
    if (s.persona === "MERCHANT") {
      const keys = await branchKeysForMerchant(s.scope_id!);
      if (!keys.includes(cur.merchant_key))
        return NextResponse.json({ error: "this settlement is not addressed to your branch" }, { status: 403 });
    }
    if (!["REQUESTED", "REJECTED"].includes(cur.status))
      return NextResponse.json({ error: `cannot submit UTR while status is ${cur.status}` }, { status: 409 });

    const upd = await rows<any>("provider", `
      UPDATE provider_branch_settlements
         SET utr = $2, status = 'UTR_SUBMITTED', utr_submitted_by = $3, utr_submitted_at = now(),
             note = COALESCE($4, note), updated_at = now()
       WHERE id = $1::uuid
      RETURNING id::text, provider_id::text, status, utr, utr_submitted_at
    `, [id, body.utr.trim(), s.email, body.note ?? null]);

    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
      VALUES ($1::uuid, $2, 'provider.settlement.utr_submitted', $3::jsonb)
    `, [upd[0].provider_id, s.email, JSON.stringify({ settlement_id: id, utr: body.utr.trim() })]).catch(() => {});

    return NextResponse.json({ settlement: upd[0] });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
