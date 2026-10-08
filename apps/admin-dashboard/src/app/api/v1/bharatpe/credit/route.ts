// POST /api/v1/bharatpe/credit — a BharatPe credit the Katana agent app captured on the merchant's
// own device, for a BharatPe MID (lib/bharatpe-store, lib/bharatpe-setup).
//
// BharatPe has no API: the agent reads the payment on the device and posts it here. The post is
// authenticated by the MID's own API key + HMAC secret (agent↔Katana auth), NOT a device key:
//   headers  x-bharatpe-key: bpk_live_… / bpk_test_…
//            x-timestamp:    ms since epoch, within ±5 min
//            x-signature:    hex HMAC-SHA256 over `${key}.${timestamp}.${rawBody}` with the secret
// A verified LIVE post is a channel-trusted BHARATPE credit: the reconciler (lib/txn-reconcile) runs
// its forensic pipeline (dedup/replay, matching ≥90) and, on a unique RRN/amount match to the
// banker's open pure-P2P order, confirms it — which fires the merchant's success callback. A TEST MID
// is recorded as simulated traffic (never auto-confirms live money).
//
// Public route (self-authenticating by the MID HMAC; whitelisted in middleware, not session-gated).

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { ingestTxnAlert, isAuthMessage } from "@/lib/txn-reconcile";
import { bharatpeMidByApiKey } from "@/lib/bharatpe-store";
import { envOfApiKey, timestampFresh, verifyBharatPeSignature } from "@/lib/bharatpe-setup";

export const dynamic = "force-dynamic";

const schema = z.object({
  amount: z.union([z.number(), z.string()]),
  // The 12-digit UPI RRN / UTR from the BharatPe transaction — the strong match key.
  utr: z.string().max(40).optional(),
  order_ref: z.string().max(80).optional(),
  payer_vpa: z.string().max(120).optional(),
  payer_name: z.string().max(140).optional(),
  narration: z.string().max(500).optional(),
  raw: z.string().max(2000).optional(),
  event_time: z.string().optional(),
  nonce: z.string().max(120).optional(),
  // BharatPe's own transaction id, kept for display / audit only (never a match key).
  bharatpe_txn_id: z.string().max(120).optional(),
}).strict();

export async function POST(req: Request) {
  const rawText = await req.text();
  const apiKey = (req.headers.get("x-bharatpe-key") ?? "").trim();
  const ts = (req.headers.get("x-timestamp") ?? "").trim();
  const sig = (req.headers.get("x-signature") ?? "").trim();

  if (!apiKey || !envOfApiKey(apiKey)) return NextResponse.json({ error: "missing or malformed x-bharatpe-key" }, { status: 401 });
  if (!timestampFresh(ts)) return NextResponse.json({ error: "stale or missing x-timestamp" }, { status: 401 });

  const mid = await bharatpeMidByApiKey(apiKey).catch(() => null);
  if (!mid) return NextResponse.json({ error: "unknown API key" }, { status: 401 });
  if (mid.status !== "ACTIVE") return NextResponse.json({ error: "this BharatPe MID is paused" }, { status: 403 });
  if (!mid.secret || !verifyBharatPeSignature(apiKey, ts, rawText, mid.secret, sig))
    return NextResponse.json({ error: "bad signature" }, { status: 401 });

  let body: z.infer<typeof schema>;
  try { body = schema.parse(JSON.parse(rawText)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  if (isAuthMessage(body.raw) || isAuthMessage(body.narration))
    return NextResponse.json({ ok: true, outcome: "REJECTED", detail: "auth/OTP message ignored" });

  // A LIVE MID's verified post is a channel-trusted BharatPe credit (auto-confirms a live order);
  // a TEST MID is recorded as simulated traffic (SIMULATED → livemode false, never auto-confirms).
  const live = envOfApiKey(apiKey) === "PROD";
  try {
    const r = await ingestTxnAlert(
      {
        source: live ? "BHARATPE" : "SIMULATED",
        merchant_id: mid.merchant_code,
        bank: "BharatPe",
        amount: body.amount,
        utr: body.utr,
        order_ref: body.order_ref,
        payer_vpa: body.payer_vpa,
        payer_name: body.payer_name,
        payee_vpa: mid.payee_vpa,
        narration: body.narration,
        raw: body.raw,
        event_time: body.event_time,
        nonce: body.nonce,
        details: body.bharatpe_txn_id ? { bharatpe_txn_id: body.bharatpe_txn_id, mid: mid.label } : { mid: mid.label },
      },
      { channelTrusted: live },
    );
    return NextResponse.json({ ok: true, ...r });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
