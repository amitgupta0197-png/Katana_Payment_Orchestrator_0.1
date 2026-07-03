// /api/settlements/[id]
//   GET   — single settlement (scoped: admin any; provider own; branch addressed).
//   PATCH — ADMIN reconciliation override: mark-for-review and/or immediately edit
//           amount / utr / status / purpose / note. This is the "any reconciliation
//           error → immediately edit" control. SUPER_ADMIN only.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { branchKeysForMerchant } from "@/lib/provider-integration";
import { SETTLEMENT_STATUSES } from "@/lib/branch-settlement";

export const dynamic = "force-dynamic";

const SELECT = `
  SELECT id::text, provider_id::text, merchant_key, beneficiary_id::text, beneficiary_snapshot,
         amount::float AS amount, currency, purpose, status, utr, transfer_mode, note,
         requested_by, requested_at, utr_submitted_by, utr_submitted_at,
         verified_by, verified_at, review_by, review_at, review_note, updated_at, created_at
    FROM provider_branch_settlements`;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  try {
    const r = (await rows<any>("provider", `${SELECT} WHERE id = $1::uuid`, [id]))[0];
    if (!r) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (s.persona === "PROVIDER" && s.scope_id !== r.provider_id) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (s.persona === "MERCHANT") {
      const keys = await branchKeysForMerchant(s.scope_id!);
      if (!keys.includes(r.merchant_key)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    return NextResponse.json({ settlement: r });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const patchSchema = z.object({
  status: z.enum(SETTLEMENT_STATUSES).optional(),
  amount: z.coerce.number().positive().max(1_000_000_000).optional(),
  utr: z.string().max(64).optional(),
  purpose: z.string().max(60).optional(),
  note: z.string().max(500).optional(),
  review: z.boolean().optional(),       // true → flag for review (sets status=REVIEW)
  review_note: z.string().max(500).optional(),
}).strict();

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  let body;
  try { body = patchSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    const cur = (await rows<any>("provider", `SELECT id::text, provider_id::text FROM provider_branch_settlements WHERE id = $1::uuid`, [id]))[0];
    if (!cur) return NextResponse.json({ error: "not found" }, { status: 404 });

    const sets: string[] = []; const args: unknown[] = [];
    const set = (col: string, val: unknown) => { args.push(val); sets.push(`${col} = $${args.length}`); };

    // mark-for-review takes precedence on status; otherwise an explicit status wins.
    if (body.review === true) { set("status", "REVIEW"); set("review_by", s.email); sets.push("review_at = now()"); }
    else if (body.status) set("status", body.status);
    if (body.review_note !== undefined) set("review_note", body.review_note);
    if (body.amount !== undefined) set("amount", body.amount);
    if (body.utr !== undefined) set("utr", body.utr.trim() || null);
    if (body.purpose !== undefined) set("purpose", body.purpose);
    if (body.note !== undefined) set("note", body.note);
    if (!sets.length) return NextResponse.json({ error: "no changes supplied" }, { status: 400 });

    args.push(id);
    const upd = await rows<any>("provider", `
      UPDATE provider_branch_settlements SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $${args.length}::uuid
      RETURNING id::text, provider_id::text, merchant_key, amount::float AS amount, status, utr, purpose, review_note, updated_at
    `, args);

    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
      VALUES ($1::uuid, $2, 'provider.settlement.admin_edit', $3::jsonb)
    `, [cur.provider_id, s.email, JSON.stringify({ settlement_id: id, changes: body })]).catch(() => {});

    return NextResponse.json({ settlement: upd[0] });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
