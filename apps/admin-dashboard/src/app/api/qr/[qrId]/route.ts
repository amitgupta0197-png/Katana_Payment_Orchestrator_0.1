// /api/qr/[qrId] — admin control over one QR.
//   PATCH { action: "approve" | "reject" | "pause" | "resume", reason? }
//
// Approval (eligibility) and routing_status (operational state) are separate axes on
// purpose — pausing an approved QR takes it out of switch candidates without withdrawing
// the approval, and un-pausing does not re-open an approval question.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { rows, pgError } from "@/lib/pg";

export const dynamic = "force-dynamic";

const ACTIONS = ["approve", "reject", "pause", "resume"] as const;
type Action = (typeof ACTIONS)[number];

export async function PATCH(req: Request, { params }: { params: Promise<{ qrId: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { qrId } = await params;

  let body: { action?: string; reason?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON body required" }, { status: 400 }); }
  const action = String(body.action ?? "").toLowerCase() as Action;
  if (!ACTIONS.includes(action))
    return NextResponse.json({ error: `action must be one of ${ACTIONS.join(", ")}` }, { status: 400 });

  try {
    const cur = await rows<{ id: string; banker_code: string; approval_status: string; routing_status: string }>(
      "provider",
      `SELECT id::text, banker_code, approval_status, routing_status FROM banker_qr WHERE id = $1::uuid`,
      [qrId],
    );
    if (!cur.length) return NextResponse.json({ error: "QR not found" }, { status: 404 });
    const qr = cur[0];

    if (action === "approve") {
      if (qr.approval_status === "APPROVED")
        return NextResponse.json({ error: "already approved" }, { status: 409 });
      await rows("provider", `
        UPDATE banker_qr
           SET approval_status = 'APPROVED', approved_by = $2, approved_at = now(),
               rejection_reason = NULL, updated_at = now()
         WHERE id = $1::uuid
      `, [qrId, s.email]);
    } else if (action === "reject") {
      // A live QR cannot be rejected out from under a store — that would leave the store
      // collecting into an endpoint the system considers invalid. Switch it away first.
      if (qr.routing_status === "ALLOCATED")
        return NextResponse.json(
          { error: "this QR is live on a store — switch the store away before rejecting it" },
          { status: 409 },
        );
      await rows("provider", `
        UPDATE banker_qr
           SET approval_status = 'REJECTED', rejection_reason = $2, approved_by = NULL,
               approved_at = NULL, updated_at = now()
         WHERE id = $1::uuid
      `, [qrId, String(body.reason ?? "").trim() || null]);
    } else if (action === "pause") {
      if (qr.routing_status === "ALLOCATED")
        return NextResponse.json(
          { error: "this QR is live on a store — switch the store away before pausing it" },
          { status: 409 },
        );
      await rows("provider",
        `UPDATE banker_qr SET routing_status = 'PAUSED', updated_at = now() WHERE id = $1::uuid`, [qrId]);
    } else {
      if (qr.routing_status !== "PAUSED")
        return NextResponse.json({ error: "QR is not paused" }, { status: 409 });
      await rows("provider",
        `UPDATE banker_qr SET routing_status = 'AVAILABLE', updated_at = now() WHERE id = $1::uuid`, [qrId]);
    }

    // qr_audit_logs, not provider_audit_logs: no merchant is involved in approving
    // inventory, and provider_audit_logs.provider_id is NOT NULL.
    await rows("provider", `
      INSERT INTO qr_audit_logs (qr_id, banker_code, action, actor, actor_role, payload)
      VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb)
    `, [qrId, qr.banker_code, `qr.${action}`, s.email, s.persona, JSON.stringify({
      reason: body.reason ?? null,
      from: { approval_status: qr.approval_status, routing_status: qr.routing_status },
    })]);

    return NextResponse.json({ ok: true, qr_id: qrId, action });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
