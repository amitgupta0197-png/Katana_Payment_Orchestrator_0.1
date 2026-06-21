// Root middleware — runs in the Edge runtime in front of every request.
//
// Responsibilities (PRODUCT_VISION §1.2 #1, layer 1):
//   1. Redirect un-authenticated UI hits to /login (with ?next=… for return).
//   2. Block Provider/Merchant personas from Super-Admin-only sections.
//   3. Route persona-portal hits (/provider-portal/*, /merchant-portal/*) only
//      to the matching persona.
//   4. Return 401 JSON for un-authenticated /api/* hits (excluding /api/auth/*
//      and /api/health which must remain open).
//   5. Return 403 JSON when an authenticated session hits an API surface the
//      persona is forbidden from (per §3.11 matrix).
//
// Cookie verification is duplicated from lib/auth.ts here because the Edge
// runtime doesn't expose node:crypto. The two implementations MUST stay
// in sync — same secret env var, same body/sig encoding (HMAC-SHA256, b64url).

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "katana_session";
const SECRET = process.env.SESSION_SECRET ?? "dev-session-secret-do-not-use-in-prod";

type Persona = "SUPER_ADMIN" | "ADMIN" | "PROVIDER" | "MERCHANT" | "OPERATOR" | "COMPLIANCE" | "FINANCE" | "RISK" | "SUPPORT";
interface Session {
  user_id: string; email: string; full_name: string;
  persona: Persona; scope_id: string | null; scope_label: string; exp: number;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(b: Uint8Array): string {
  let bin = ""; for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function verifySession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const macBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
    const expected = bytesToB64url(macBytes);
    if (expected.length !== sig.length) return null;
    let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    if (diff !== 0) return null;
    const json = new TextDecoder().decode(b64urlToBytes(body));
    const parsed = JSON.parse(json) as Session;
    if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch { return null; }
}

const PUBLIC_UI = ["/login"];
// /api/pay is the merchant-facing order endpoint — authenticated by the
// merchant's Katana Key + Salt signature (not a session cookie), so it must
// bypass the session gate here.
// /api/pay (merchant Key+Salt signed) and /api/gateway/payu/return (PayU
// response-hash authenticated) bypass the session gate.
// /api/v1/webhooks/payment-status (HMAC x-signature) and /api/v1/cron/daily
// (x-cron-key secret) authenticate themselves, so they bypass the session gate.
const PUBLIC_API = ["/api/auth/login", "/api/auth/logout", "/api/auth/me", "/api/health", "/api/pay", "/api/gateway/payu/return", "/api/pay-result", "/api/v1/webhooks/payment-status", "/api/v1/cron/daily"];
const VENDOR_CALLBACK = /^\/api\/vendors\/[^/]+\/callback\/?$/;
const SANDBOX_PREFIX = /^\/api\/sandbox(\/|$)/;

const SUPER_ADMIN_UI = [
  "/admin", "/tenants", "/routing", "/pg-adapter", "/bank-adapter",
  "/crypto-rail", "/integrations", "/vendors", "/channels", "/fund",
  "/admin-log", "/agents", "/events",
];

const SUPER_ADMIN_API = [
  "/api/admin", "/api/tenants", "/api/routing", "/api/pg-adapter",
  "/api/bank-adapter", "/api/crypto-rail", "/api/integrations", "/api/channels",
  "/api/settlement/trigger", "/api/svc-tables", "/api/events",
  "/api/admin/routing", "/api/admin/webhooks",
  "/api/admin/slos", "/api/admin/incidents", "/api/recon/run",
];

const PROVIDER_PORTAL_UI = "/provider-portal";
const PROVIDER_PORTAL_API = "/api/provider-portal";
const MERCHANT_PORTAL_UI = "/merchant-portal";
const MERCHANT_PORTAL_API = "/api/merchant-portal";

function isUnder(path: string, prefixes: string[] | string): boolean {
  const list = Array.isArray(prefixes) ? prefixes : [prefixes];
  return list.some((p) => path === p || path.startsWith(p + "/"));
}

function jsonError(status: number, message: string) {
  return new NextResponse(JSON.stringify({ error: message }), {
    status, headers: { "content-type": "application/json" },
  });
}

// Forward the request URL's pathname so server components (e.g. the root
// layout's standalone-shell switch) can read it from headers — Next 15 doesn't
// expose this in the App Router otherwise.
function withPathname(req: NextRequest): Headers {
  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname);
  return headers;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  if (isApi) {
    if (PUBLIC_API.includes(pathname) || VENDOR_CALLBACK.test(pathname) || SANDBOX_PREFIX.test(pathname)) {
      return NextResponse.next({ request: { headers: withPathname(req) } });
    }
  } else {
    if (PUBLIC_UI.includes(pathname)) return NextResponse.next({ request: { headers: withPathname(req) } });
  }

  const token = req.cookies.get(COOKIE_NAME)?.value;
  const session = await verifySession(token);

  if (!session) {
    if (isApi) return jsonError(401, "not authenticated");
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  const persona = session.persona;

  if (isApi ? isUnder(pathname, SUPER_ADMIN_API) : isUnder(pathname, SUPER_ADMIN_UI)) {
    if (persona !== "SUPER_ADMIN") {
      return isApi
        ? jsonError(403, `requires SUPER_ADMIN persona; you are ${persona}`)
        : NextResponse.redirect(new URL("/", req.url));
    }
  }

  if (isUnder(pathname, isApi ? PROVIDER_PORTAL_API : PROVIDER_PORTAL_UI)) {
    if (persona !== "PROVIDER") {
      return isApi
        ? jsonError(403, `requires PROVIDER persona; you are ${persona}`)
        : NextResponse.redirect(new URL(persona === "SUPER_ADMIN" ? "/" : "/merchant-portal", req.url));
    }
  }

  if (isUnder(pathname, isApi ? MERCHANT_PORTAL_API : MERCHANT_PORTAL_UI)) {
    if (persona !== "MERCHANT") {
      return isApi
        ? jsonError(403, `requires MERCHANT persona; you are ${persona}`)
        : NextResponse.redirect(new URL(persona === "SUPER_ADMIN" ? "/" : "/provider-portal", req.url));
    }
  }

  const headers = withPathname(req);
  headers.set("x-session-persona", persona);
  if (session.scope_id) headers.set("x-session-scope-id", session.scope_id);
  headers.set("x-session-user-id", session.user_id);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|css|js|map)$).*)"],
};
