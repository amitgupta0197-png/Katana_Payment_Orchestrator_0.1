// POST /api/oauth/google/gmail-push — Gmail push webhook. Google Cloud Pub/Sub posts
// here the instant a connected inbox receives mail; we immediately poll that inbox so
// a payment confirms within ~1-2s instead of waiting for the next poll. Public, but
// guarded by a shared ?token= secret (GOOGLE_PUBSUB_TOKEN) set on the subscription's
// push URL. Always returns 200 so Pub/Sub doesn't retry-storm. Whitelisted (/api/oauth).

import { NextResponse } from "next/server";
import { pollInboxByEmail } from "@/lib/email-ingest";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const expected = process.env.GOOGLE_PUBSUB_TOKEN;
  if (expected && new URL(req.url).searchParams.get("token") !== expected) {
    return new NextResponse("forbidden", { status: 403 });
  }
  try {
    const body: any = await req.json().catch(() => ({}));
    const dataB64: string | undefined = body?.message?.data;
    if (dataB64) {
      const decoded = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8"));
      const email: string | undefined = decoded?.emailAddress;
      if (email) await pollInboxByEmail(email);
    }
  } catch { /* swallow — we always ack so Pub/Sub doesn't redeliver endlessly */ }
  return NextResponse.json({ ok: true });
}
