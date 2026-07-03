// GET /api/oauth/google/callback — Google redirects here after the merchant approves.
// We exchange the code for a refresh token, store it against the merchant's inbox
// (auth_type=OAUTH), and show a friendly "Connected" page. Public; the state param is
// HMAC-signed so we trust the merchant binding. Whitelisted in middleware (/api/oauth).

import { NextResponse } from "next/server";
import { exchangeCode, verifyState, oauthConfigured, startGmailWatch } from "@/lib/gmail-oauth";
import { rows } from "@/lib/pg";

export const dynamic = "force-dynamic";

function page(title: string, msg: string, ok: boolean): NextResponse {
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
  if (err) return page("Sign-in cancelled", `Google returned "${err}". You can close this and try again from the app.`, false);

  const code = url.searchParams.get("code");
  const state = verifyState(url.searchParams.get("state") || "");
  if (!code || !state) return page("Invalid link", "This sign-in link is invalid or expired. Tap “Sign in with Google” again in the app.", false);

  try {
    const { refreshToken, email } = await exchangeCode(code);
    if (!email) return page("Couldn’t read account", "Google didn’t return your email address. Please try again.", false);
    if (!refreshToken) return page("Try again", `Google didn’t issue a renewable token for ${email}. Remove access at myaccount.google.com → Security → Third-party access, then reconnect.`, false);

    await rows("vendorGateway", `
      INSERT INTO vendor_email_inboxes (merchant_id, email, auth_type, refresh_token, enabled, status, last_error, updated_at)
      VALUES ($1, $2, 'OAUTH', $3, true, 'OK', null, now())
      ON CONFLICT (email) DO UPDATE SET
        merchant_id   = COALESCE($1, vendor_email_inboxes.merchant_id),
        auth_type     = 'OAUTH',
        refresh_token = $3,
        enabled       = true,
        status        = 'OK',
        last_error    = null,
        updated_at    = now()
    `, [state.merchant, email.toLowerCase(), refreshToken]);

    // Start the Gmail push watch so new mail is delivered instantly (best-effort; the
    // 10s poll is the fallback if Pub/Sub isn't configured).
    try {
      const w = await startGmailWatch(refreshToken);
      if (w?.expiration) await rows("vendorGateway", `UPDATE vendor_email_inboxes SET watch_expiration = to_timestamp(($2::bigint)/1000) WHERE email = $1`, [email.toLowerCase(), w.expiration]).catch(() => {});
    } catch { /* push optional — polling still works */ }

    return page("Connected!", `${email} is now connected${state.merchant ? ` to merchant ${state.merchant}` : ""}. Close this tab and return to the Katana app — payments will confirm automatically.`, true);
  } catch (e) {
    return page("Something went wrong", (e as Error).message, false);
  }
}
