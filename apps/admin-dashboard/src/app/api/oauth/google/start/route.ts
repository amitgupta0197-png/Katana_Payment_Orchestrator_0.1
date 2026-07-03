// GET /api/oauth/google/start?m=<merchant>&d=<device> — begins the "Sign in with
// Google" flow. The Katana app opens this URL in a browser; we redirect to Google's
// consent screen (gmail.readonly). Public (the merchant/device binding is carried in
// a signed state param). Whitelisted in middleware (/api/oauth prefix).

import { NextResponse } from "next/server";
import { buildAuthUrl, oauthConfigured } from "@/lib/gmail-oauth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!oauthConfigured()) {
    return new NextResponse("Google sign-in is not configured on the server yet.", {
      status: 503, headers: { "content-type": "text/plain" },
    });
  }
  const url = new URL(req.url);
  const merchant = url.searchParams.get("m") || undefined;
  const device = url.searchParams.get("d") || undefined;
  return NextResponse.redirect(buildAuthUrl(merchant, device));
}
