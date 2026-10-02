// POST /api/v1/device/email-config — the Katana agent app connects the Gmail that
// receives Paytm/PhonePe payment emails (Gmail address + Google App Password). Stored
// per-merchant in vendor_email_inboxes; the email poller then reads it over IMAP.
//
// Device-authenticated (sandbox bypass / HMAC, same as txn-alert & heartbeat). Does a
// best-effort IMAP login so the app gets instant "connected" / error feedback.
// Whitelisted in middleware (PUBLIC_API).

import { NextResponse } from "next/server";
import { openText, sealText } from "@/lib/sealed-text";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { verifyDeviceRequest } from "@/lib/device-auth";
import { testInboxConnection } from "@/lib/email-ingest";
import { raiseAlert } from "@/lib/ops-alert";

export const dynamic = "force-dynamic";

// The mail servers a mailbox may be on. All are IMAP over TLS on 993.
const IMAP_HOSTS = new Set(["imap.gmail.com", "outlook.office365.com", "imap-mail.outlook.com", "imap.mail.yahoo.com", "imap.zoho.in", "imap.zoho.com"]);

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
  const raw = await req.text();
  const auth = verifyDeviceRequest(req, raw);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  let body: z.infer<typeof schema>;
  try { body = schema.parse(JSON.parse(raw)); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  const email = body.email.trim().toLowerCase();
  // App Passwords are shown with spaces ("abcd efgh ijkl mnop"); strip them.
  const appPw = body.app_password?.replace(/\s+/g, "") || null;

  // WHERE THE PASSWORD IS SENT. The mail server is one of the known providers, never a host the
  // request names freely: the route would otherwise connect to any address it is given, and
  // for a mailbox already on file it would hand that mailbox's stored password to it.
  const host = (body.host ?? "imap.gmail.com").trim().toLowerCase();
  if (!IMAP_HOSTS.has(host)) return NextResponse.json({ error: "this mail provider is not supported" }, { status: 400 });

  try {
    const existing = (await rows<{ app_password: string; host: string; merchant_id: string | null; approved: boolean }>("vendorGateway",
      `SELECT app_password, host, merchant_id, approved FROM vendor_email_inboxes WHERE email = $1`, [email]))[0];
    if (!existing && !appPw) return NextResponse.json({ error: "app password required for a new inbox" }, { status: 400 });
    // A mailbox on file keeps its mail server and its merchant. A request that names another
    // server must bring the password itself; the stored one is only ever sent where it came from.
    if (existing && body.host && host !== existing.host.toLowerCase() && !appPw)
      return NextResponse.json({ error: "send the app password to change this mailbox's mail server" }, { status: 400 });
    const effectivePw = appPw ?? openText(existing!.app_password);   // sealed at rest (lib/sealed-text)

    // Best-effort connect test for immediate feedback; we still SAVE either way so the
    // user can fix the password and the cron retries.
    const test = await testInboxConnection({ email, appPassword: effectivePw, host, port: 993 });
    const status = test.ok ? "OK" : `ERROR: ${test.error ?? "connect failed"}`;

    // A new mailbox starts UNAPPROVED (vendorGateway 0036): the request is signed with a key
    // every phone shares, so it does not prove whose mailbox this is. An existing one keeps
    // its merchant and its approval.
    await rows("vendorGateway", `
      INSERT INTO vendor_email_inboxes (merchant_id, email, app_password, host, port, enabled, status, last_error, updated_at, approved, linked_via)
      VALUES ($1, $2, $3, $4, 993, COALESCE($5,true), $6, $7, now(), false, 'DEVICE')
      ON CONFLICT (email) DO UPDATE SET
        merchant_id  = COALESCE(vendor_email_inboxes.merchant_id, $1),
        app_password = COALESCE(NULLIF($3,''), vendor_email_inboxes.app_password),
        host         = CASE WHEN NULLIF($3,'') IS NOT NULL THEN $4 ELSE vendor_email_inboxes.host END,
        enabled      = COALESCE($5, vendor_email_inboxes.enabled),
        status       = $6, last_error = $7, updated_at = now()
    `, [body.merchant_id ?? null, email, appPw ? sealText(appPw) : "", host, body.enabled ?? null, status, test.ok ? null : (test.error ?? "connect failed")]);

    if (!existing?.approved)
      await raiseAlert({
        key: `mailbox:pending:${email}`, severity: "WARN", repeatMinutes: 720,
        title: "A mailbox is waiting for approval",
        body: `${email} was linked from a phone${body.merchant_id ? ` for merchant ${body.merchant_id}` : ""}. Check it is the merchant's own, then approve it under Admin → Mailboxes. Nothing is read from it until then.`,
      });

    if (!test.ok) return NextResponse.json({ ok: false, status: "saved", error: test.error ?? "could not connect — check the app password & that IMAP is enabled" });
    return NextResponse.json({ ok: true, status: existing?.approved ? "connected" : "pending_approval" });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
