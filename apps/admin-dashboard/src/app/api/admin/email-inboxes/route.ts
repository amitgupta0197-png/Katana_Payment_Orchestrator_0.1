// The mailboxes linked for payment mail, and their approval (vendorGateway 0036).
//   GET  /api/admin/email-inboxes                       every mailbox, the ones waiting first
//   POST /api/admin/email-inboxes  { email, action }    approve | disable
//
// A mailbox is linked from the phone app without a login, so it is read only once a Super
// Admin has approved it here — after checking it is the merchant's own. Approval is audited.
// No password or token is ever returned.
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";
import { resolveAlert } from "@/lib/ops-alert";
import { openText } from "@/lib/sealed-text";
import { startGmailWatch } from "@/lib/gmail-oauth";

export const dynamic = "force-dynamic";

const COLS = `id::text, merchant_id, email, auth_type, host, enabled, approved, approved_by, approved_at,
              linked_via, status, last_polled_at, last_error, created_at`;

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const inboxes = await rows("vendorGateway", `
      SELECT ${COLS} FROM vendor_email_inboxes i
       ORDER BY (i.enabled AND NOT i.approved) DESC, i.created_at DESC LIMIT 500`);
    return NextResponse.json({ inboxes });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  email: z.string().email().max(160),
  action: z.enum(["approve", "disable"]),
  note: z.string().trim().max(500).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const email = body.email.toLowerCase();
  try {
    const before = (await rows<{ merchant_id: string | null; enabled: boolean; approved: boolean; auth_type: string; refresh_token: string | null }>("vendorGateway",
      `SELECT merchant_id, enabled, approved, auth_type, refresh_token FROM vendor_email_inboxes WHERE email = $1`, [email]))[0];
    if (!before) return NextResponse.json({ error: "mailbox not found" }, { status: 404 });
    // A mailbox with no merchant would have its credits matched against every merchant's orders.
    if (body.action === "approve" && !before.merchant_id)
      return NextResponse.json({ error: "this mailbox is not linked to a merchant and cannot be approved" }, { status: 400 });

    const after = (await rows("vendorGateway", body.action === "approve" ? `
      UPDATE vendor_email_inboxes SET approved = true, enabled = true, approved_by = $2, approved_at = now(), updated_at = now()
       WHERE email = $1 RETURNING ${COLS}` : `
      UPDATE vendor_email_inboxes SET approved = false, enabled = false, approved_by = NULL, approved_at = NULL, updated_at = now()
       WHERE email = $1 RETURNING ${COLS}`, body.action === "approve" ? [email, g.session.email] : [email]))[0];

    await wormAppend({
      actorId: g.session.user_id, actorEmail: g.session.email, action: `mailbox.${body.action}`,
      resourceType: "email_inbox", resourceId: email,
      before: { merchant_id: before.merchant_id, enabled: before.enabled, approved: before.approved },
      after: { merchant_id: before.merchant_id, enabled: body.action === "approve", approved: body.action === "approve" },
      notes: body.note,
    }).catch(() => {});
    await resolveAlert(`mailbox:pending:${email}`, body.action === "approve" ? `Approved by ${g.session.email}.` : `Switched off by ${g.session.email}.`);

    // Mail is pushed, not only polled, once a Gmail mailbox is approved. Best-effort.
    if (body.action === "approve" && before.auth_type === "OAUTH" && before.refresh_token) {
      try {
        const w = await startGmailWatch(openText(before.refresh_token));
        if (w?.expiration) await rows("vendorGateway", `UPDATE vendor_email_inboxes SET watch_expiration = to_timestamp(($2::bigint)/1000) WHERE email = $1`, [email, w.expiration]);
      } catch { /* the poll still reads it */ }
    }
    return NextResponse.json({ inbox: after });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
