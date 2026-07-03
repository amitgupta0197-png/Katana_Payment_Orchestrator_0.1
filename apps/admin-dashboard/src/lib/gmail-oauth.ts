// Google OAuth helper for the "Sign in with Google" email-connect flow. The merchant
// taps a button in the app → browser opens Google consent → Google redirects back to
// our callback → we store a long-lived refresh token and read Gmail via the API. The
// client secret never leaves the server; the app only opens a URL.
//
// Config (.env.local on the VPS):
//   GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
//   GOOGLE_OAUTH_CLIENT_SECRET=...
//   GOOGLE_OAUTH_REDIRECT=https://glhouse.shop/api/oauth/google/callback   (default)

import { signPayload } from "@/lib/fifo-notify";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// gmail.readonly is enough — we never modify the mailbox (idempotency is tracked
// server-side in vendor_email_seen). `openid email` lets us learn which address it is.
const SCOPES = "openid email https://www.googleapis.com/auth/gmail.readonly";

export function oauthConfigured(): boolean {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}
function redirectUri(): string {
  return process.env.GOOGLE_OAUTH_REDIRECT || "https://glhouse.shop/api/oauth/google/callback";
}

// State = base64url(payload) + "." + HMAC(payload), so the callback can trust the
// merchant/device binding it set (and reject tampering / CSRF).
export function signState(merchant: string | undefined, device: string | undefined): string {
  const payload = Buffer.from(JSON.stringify({ merchant: merchant || null, device: device || null, t: Date.now() })).toString("base64url");
  return `${payload}.${signPayload(payload)}`;
}
export function verifyState(state: string): { merchant: string | null; device: string | null } | null {
  const i = state.lastIndexOf(".");
  if (i < 0) return null;
  const payload = state.slice(0, i), sig = state.slice(i + 1);
  if (signPayload(payload) !== sig) return null;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { return null; }
}

export function buildAuthUrl(merchant: string | undefined, device: string | undefined): string {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",     // get a refresh token
    prompt: "consent",          // force refresh-token issuance every time
    include_granted_scopes: "true",
    state: signState(merchant, device),
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export async function exchangeCode(code: string): Promise<{ refreshToken: string | null; accessToken: string; email: string | null }> {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`token exchange failed: HTTP ${r.status} ${await r.text()}`);
  const j: any = await r.json();
  let email: string | null = null;
  if (j.id_token) {
    try { email = JSON.parse(Buffer.from(String(j.id_token).split(".")[1], "base64url").toString()).email ?? null; } catch { /* ignore */ }
  }
  return { refreshToken: j.refresh_token ?? null, accessToken: j.access_token, email };
}

// Cached access token per refresh token (Google access tokens live ~1h). Lets us poll
// every ~20s without calling Google's token endpoint each time.
const tokenCache = new Map<string, { token: string; exp: number }>();
export async function getAccessToken(refreshToken: string): Promise<string> {
  const c = tokenCache.get(refreshToken);
  if (c && c.exp > Date.now() + 60_000) return c.token;
  const token = await refreshAccessToken(refreshToken);
  tokenCache.set(refreshToken, { token, exp: Date.now() + 55 * 60_000 });
  return token;
}

// Start/extend a Gmail push "watch" on the INBOX → Google publishes a Pub/Sub message
// to GOOGLE_PUBSUB_TOPIC whenever new mail arrives. Returns the watch expiration (ms
// epoch) so we can renew before it lapses (Gmail caps watches at 7 days). No-op when
// the topic isn't configured.
export async function startGmailWatch(refreshToken: string): Promise<{ historyId: string; expiration: string } | null> {
  const topicName = process.env.GOOGLE_PUBSUB_TOPIC;
  if (!topicName) return null;
  const access = await getAccessToken(refreshToken);
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/watch", {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    body: JSON.stringify({ topicName, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" }),
  });
  if (!r.ok) throw new Error(`gmail watch failed: HTTP ${r.status} ${await r.text()}`);
  const j: any = await r.json();
  return { historyId: j.historyId, expiration: j.expiration };
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
    grant_type: "refresh_token",
  });
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`token refresh failed: HTTP ${r.status}`);
  const j: any = await r.json();
  if (!j.access_token) throw new Error("no access_token in refresh response");
  return j.access_token;
}
