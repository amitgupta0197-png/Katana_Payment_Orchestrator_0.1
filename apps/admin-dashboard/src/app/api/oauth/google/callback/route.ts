// GET /api/oauth/google/callback — Google redirects here after the merchant approves.
// We exchange the code for a refresh token, store it against the merchant's inbox
// (auth_type=OAUTH), and show a friendly "Connected" page. Public. Whitelisted in middleware
// (/api/oauth).
//
// WHAT THE SIGNED STATE DOES AND DOES NOT PROVE. It proves this sign-in was started on
// Katana's own start page within the last 15 minutes. It does NOT prove who started it: that
// page needs no login and takes the merchant code from its address, so anyone can begin a
// sign-in "for" any merchant. Therefore:
//   • a mailbox linked here for the first time is stored UNAPPROVED. Nothing reads it until
//     Katana staff approve it (vendorGateway 0036, Admin → Mailboxes);
//   • a mailbox already linked keeps the merchant it belongs to. Signing in again renews its
//     token; it never moves the mailbox to the merchant named in the link.
// Everything printed on the page is escaped: the error text comes from the address bar.

import { NextResponse } from "next/server";
import { sealText } from "@/lib/sealed-text";
import { exchangeCode, verifyState, oauthConfigured, startGmailWatch } from "@/lib/gmail-oauth";
import { rows } from "@/lib/pg";
import { raiseAlert } from "@/lib/ops-alert";

export const dynamic = "force-dynamic";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function page(rawTitle: string, rawMsg: string, ok: boolean): NextResponse {
  const title = esc(rawTitle), msg = esc(rawMsg);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,Roboto,Segoe UI,sans-serif;background:#0f1b2d;color:#e8eefc;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center}
.card{background:#16233a;border:1px solid #25344f;border-radius:16px;padding:30px 26px;max-width:380px}
.ic{font-size:48px;margin-bottom:10px}h1{font-size:21px;margin:0 0 8px}p{color:#9fb0cc;font-size:14px;line-height:1.55;margin:0}</style></head>
<body><div class="card"><div class="ic">${ok ? "✅" : "⚠️"}</div><h1>${title}</h1><p>${msg}</p></div></body></html>`;
  return new NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function GET(req: Request) {
  if (!oauthConfigured()) return page("Not configured", "Google sign-in isn't set up on the server yet.", false);
  const url = new URL(req.url);
  const err = url.searchParams.get("error");
  if (err) return page("Sign-in cancelled", `Google returned "${err.slice(0, 80)}". You can close this and try again from the app.`, false);

  const code = url.searchParams.get("code");
  const state = verifyState(url.searchParams.get("state") || "");
  if (!code || !state) return page("Invalid link", "This sign-in link is invalid or expired. Tap “Sign in with Google” again in the app.", false);

  try {
    const { refreshToken, email } = await exchangeCode(code);
    if (!email) return page("Couldn’t read account", "Google didn’t return your email address. Please try again.", false);
    if (!refreshToken) return page("Try again", `Google didn’t issue a renewable token for ${email}. Remove access at myaccount.google.com → Security → Third-party access, then reconnect.`, false);

    const address = email.toLowerCase();
    const existing = (await rows<{ merchant_id: string | null; approved: boolean }>("vendorGateway",
      `SELECT merchant_id, approved FROM vendor_email_inboxes WHERE email = $1`, [address]))[0];
    // The mailbox belongs to a merchant already: it stays there, whatever the link says.
    if (existing?.merchant_id && state.merchant && existing.merchant_id !== state.merchant)
      return page("Already connected", `${email} is connected to another account and was not changed. Ask Katana support if it should move.`, false);

    await rows("vendorGateway", `
      INSERT INTO vendor_email_inboxes (merchant_id, email, auth_type, refresh_token, enabled, status, last_error, updated_at, approved, linked_via)
      VALUES ($1, $2, 'OAUTH', $3, true, 'OK', null, now(), false, 'OAUTH_LINK')
      ON CONFLICT (email) DO UPDATE SET
        merchant_id   = COALESCE(vendor_email_inboxes.merchant_id, $1),
        auth_type     = 'OAUTH',
        refresh_token = $3,
        enabled       = true,
        status        = 'OK',
        last_error    = null,
        updated_at    = now()
    `, [state.merchant, address, sealText(refreshToken)]);   // sealed at rest (lib/sealed-text)
    const approved = existing?.approved === true;
    if (!approved)
      await raiseAlert({
        key: `mailbox:pending:${address}`, severity: "WARN", repeatMinutes: 720,
        title: "A mailbox is waiting for approval",
        body: `${address} was linked${state.merchant ? ` for merchant ${state.merchant}` : ""}. Check it is the merchant's own, then approve it under Admin → Mailboxes. Nothing is read from it until then.`,
      });

    // Start the Gmail push watch so new mail is delivered instantly (best-effort; the
    // 10s poll is the fallback if Pub/Sub isn't configured).
    if (approved) try {
      const w = await startGmailWatch(refreshToken);
      if (w?.expiration) await rows("vendorGateway", `UPDATE vendor_email_inboxes SET watch_expiration = to_timestamp(($2::bigint)/1000) WHERE email = $1`, [email.toLowerCase(), w.expiration]).catch(() => {});
    } catch { /* push optional — polling still works */ }

    return approved
      ? page("Connected!", `${email} is connected again. Close this tab and return to the Katana app — payments will confirm automatically.`, true)
      : page("Almost there", `${email} is linked. Katana will check it and switch it on; payments confirm automatically from then. You can close this tab.`, true);
  } catch (e) {
    console.error("[oauth/google/callback]", (e as Error).message);
    return page("Something went wrong", "The mailbox could not be linked. Please try again from the app.", false);
  }
}
