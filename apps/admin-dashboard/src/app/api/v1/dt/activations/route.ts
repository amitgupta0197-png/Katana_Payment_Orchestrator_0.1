// Admin side of merchant DT activation (2026-07-31).
//
//   GET  — the review queue: every activation request, newest first.
//   POST — decide one: APPROVED / REJECTED / REVOKED.
//
// Approving is what unlocks a merchant's DT dashboard, so it is gated to the same
// personas that approve DT purchases.
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { rows, pgError } from "@/lib/pg";
import { auditDt } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;

  const activations = await rows<any>("provider", `
    SELECT id::text, merchant_id, model, status,
           COALESCE(request_note,'') AS request_note, COALESCE(review_note,'') AS review_note,
           COALESCE(requested_by,'') AS requested_by, requested_at,
           COALESCE(reviewed_by,'') AS reviewed_by, reviewed_at
      FROM merchant_dt_activations
     ORDER BY CASE status WHEN 'REQUESTED' THEN 0 ELSE 1 END, requested_at DESC
     LIMIT 300
  `).catch(() => []);

  return NextResponse.json({
    activations,
    summary: {
      pending: activations.filter((a: any) => a.status === "REQUESTED").length,
      approved: activations.filter((a: any) => a.status === "APPROVED").length,
    },
  });
}

const schema = z.object({
  id: z.string().uuid(),
  to: z.enum(["APPROVED", "REJECTED", "REVOKED"]),
  note: z.string().trim().max(1000).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
  if ("response" in g) return g.response;

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const cur = await rows<{ merchant_id: string; status: string; model: string }>("provider",
    `SELECT merchant_id, status, model FROM merchant_dt_activations WHERE id = $1::uuid`, [body.id]).catch(() => []);
  if (!cur.length) return NextResponse.json({ error: "activation request not found" }, { status: 404 });

  // Only a pending request can be approved or rejected; only a live activation can be
  // revoked. Without this an already-rejected row could be flipped to APPROVED later.
  const from = cur[0].status;
  const legal =
    (body.to === "APPROVED" && from === "REQUESTED") ||
    (body.to === "REJECTED" && from === "REQUESTED") ||
    (body.to === "REVOKED"  && from === "APPROVED");
  if (!legal) return NextResponse.json({ error: `cannot move ${from} → ${body.to}` }, { status: 409 });

  try {
    await rows("provider", `
      UPDATE merchant_dt_activations
         SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now(), updated_at = now()
       WHERE id = $1::uuid
    `, [body.id, body.to, body.note ?? null, g.session.email]);

    await auditDt(g.session.email, `DT_ACTIVATION_${body.to}`, "merchant_dt_activation", body.id,
      { status: from }, { status: body.to, merchant_id: cur[0].merchant_id, model: cur[0].model });

    return NextResponse.json({ ok: true, merchant_id: cur[0].merchant_id, status: body.to });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
