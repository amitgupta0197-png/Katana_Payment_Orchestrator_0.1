// /api/settlements/[id]/verify — the PROVIDER verifies (or rejects) a branch's
// submitted UTR after confirming the money landed in its beneficiary account.
//   outcome=VERIFIED → settled; the branch's outstanding is reduced by this amount.
//   outcome=REJECTED → back to the branch to correct + resubmit.
//   SUPER_ADMIN + PROVIDER(own).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const schema = z.object({ outcome: z.enum(["VERIFIED", "REJECTED"]), note: z.string().max(500).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    const cur = (await rows<any>("provider",
      `SELECT id::text, provider_id::text, status FROM provider_branch_settlements WHERE id = $1::uuid`, [id]))[0];
    if (!cur) return NextResponse.json({ error: "settlement not found" }, { status: 404 });
    if (s.persona === "PROVIDER" && s.scope_id !== cur.provider_id)
      return NextResponse.json({ error: "not your settlement" }, { status: 403 });
    if (!["UTR_SUBMITTED", "REVIEW"].includes(cur.status))
      return NextResponse.json({ error: `can only verify a submitted/under-review settlement (is ${cur.status})` }, { status: 409 });

    const upd = await rows<any>("provider", `
      UPDATE provider_branch_settlements
         SET status = $2,
             verified_by = $3,
             verified_at = ${body.outcome === "VERIFIED" ? "now()" : "NULL"},
             note = COALESCE($4, note), updated_at = now()
       WHERE id = $1::uuid
      RETURNING id::text, provider_id::text, status, verified_at
    `, [id, body.outcome, s.email, body.note ?? null]);

    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
      VALUES ($1::uuid, $2, $3, $4::jsonb)
    `, [cur.provider_id, s.email,
        body.outcome === "VERIFIED" ? "provider.settlement.verified" : "provider.settlement.rejected",
        JSON.stringify({ settlement_id: id, note: body.note ?? null })]).catch(() => {});

    return NextResponse.json({ settlement: upd[0] });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
