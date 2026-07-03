// POST /api/v1/device/email-config — the Katana agent app connects the Gmail that
// receives Paytm/PhonePe payment emails (Gmail address + Google App Password). Stored
// per-merchant in vendor_email_inboxes; the email poller then reads it over IMAP.
//
// Device-authenticated (sandbox bypass / HMAC, same as txn-alert & heartbeat). Does a
// best-effort IMAP login so the app gets instant "connected" / error feedback.
// Whitelisted in middleware (PUBLIC_API).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { signPayload } from "@/lib/fifo-notify";
import { testInboxConnection } from "@/lib/email-ingest";

export const dynamic = "force-dynamic";

const schema = z.object({
  device_id: z.string().max(120).optional(),
  merchant_id: z.string().max(120).optional(),
  email: z.string().email().max(160),
  app_password: z.string().max(120).optional(),
  host: z.string().max(120).optional(),
  port: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

export async function POST(req: Request) {
  const sandbox = req.headers.get("x-sandbox") === "1";
  const raw = await req.text();
  if (!sandbox) {
    const sig = req.headers.get("x-signature") ?? "";
    if (!sig || signPayload(raw) !== sig) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  let body: z.infer<typeof schema>;
  try { body = schema.parse(JSON.parse(raw)); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  const email = body.email.trim().toLowerCase();
  // App Passwords are shown with spaces ("abcd efgh ijkl mnop"); strip them.
  const appPw = body.app_password?.replace(/\s+/g, "") || null;

  try {
    const existing = (await rows<{ app_password: string }>("vendorGateway",
      `SELECT app_password FROM vendor_email_inboxes WHERE email = $1`, [email]))[0];
    if (!existing && !appPw) return NextResponse.json({ error: "app password required for a new inbox" }, { status: 400 });
    const effectivePw = appPw ?? existing!.app_password;

    // Best-effort connect test for immediate feedback; we still SAVE either way so the
    // user can fix the password and the cron retries.
    const test = await testInboxConnection({ email, appPassword: effectivePw, host: body.host, port: body.port });
    const status = test.ok ? "OK" : `ERROR: ${test.error ?? "connect failed"}`;

    await rows("vendorGateway", `
      INSERT INTO vendor_email_inboxes (merchant_id, email, app_password, host, port, enabled, status, last_error, updated_at)
      VALUES ($1, $2, $3, COALESCE($4,'imap.gmail.com'), COALESCE($5,993), COALESCE($6,true), $7, $8, now())
      ON CONFLICT (email) DO UPDATE SET
        merchant_id  = COALESCE($1, vendor_email_inboxes.merchant_id),
        app_password = COALESCE(NULLIF($3,''), vendor_email_inboxes.app_password),
        host         = COALESCE($4, vendor_email_inboxes.host),
        port         = COALESCE($5, vendor_email_inboxes.port),
        enabled      = COALESCE($6, vendor_email_inboxes.enabled),
        status       = $7, last_error = $8, updated_at = now()
    `, [body.merchant_id ?? null, email, appPw ?? "", body.host ?? null, body.port ?? null, body.enabled ?? null, status, test.ok ? null : (test.error ?? "connect failed")]);

    if (!test.ok) return NextResponse.json({ ok: false, status: "saved", error: test.error ?? "could not connect — check the app password & that IMAP is enabled" });
    return NextResponse.json({ ok: true, status: "connected" });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
