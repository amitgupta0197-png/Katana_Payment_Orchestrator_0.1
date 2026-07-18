// POST /api/v1/txn-alert — Transaction Intelligence ingestion (architecture §3).
//
// A company-managed forwarder device posts a parsed bank-credit alert. The reconciler
// runs the forensic pipeline (OTP filter, dedup/replay, device trust, matching) and
// either auto-confirms the order or opens a manual case / security alert.
//
// Public route (device-authenticated, not session-gated; whitelisted in middleware).
// Auth (architecture §8):
//   - signed mode: HMAC-SHA256(x-signature) over the raw body + x-timestamp within
//                  ±5 min (replay window); nonce reuse is rejected by the reconciler.
//   - sandbox mode: header `x-sandbox: 1` skips signing/timestamp (cockpit tester,
//                   sandbox forwarder).

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { verifyDeviceRequest } from "@/lib/device-auth";
import { ingestTxnAlert, isAuthMessage } from "@/lib/txn-reconcile";

export const dynamic = "force-dynamic";

const schema = z.object({
  source: z.enum(["DEVICE", "SMS", "NOTIFICATION", "ACCESSIBILITY", "EMAIL", "BANK_API", "SIMULATED"]).default("DEVICE"),
  device_id: z.string().max(120).optional(),
  merchant_id: z.string().max(120).optional(),
  bank: z.string().max(60).optional(),
  sender: z.string().max(120).optional(),
  direction: z.enum(["CREDIT", "DEBIT"]).default("CREDIT"),
  amount: z.union([z.number(), z.string()]),
  utr: z.string().max(40).optional(),
  order_ref: z.string().max(80).optional(),
  payer_vpa: z.string().max(120).optional(),
  payer_name: z.string().max(140).optional(),
  payee_vpa: z.string().max(120).optional(),
  narration: z.string().max(500).optional(),
  raw: z.string().max(2000).optional(),
  event_time: z.string().optional(),
  nonce: z.string().max(120).optional(),
  parser_version: z.string().max(40).optional(),
  sim_id: z.string().max(120).optional(),
  app_hash: z.string().max(128).optional(),
});

export async function POST(req: Request) {
  const rawText = await req.text();
  // Device auth: valid HMAC signature (timestamp bound in) over the raw body, or the
  // x-sandbox transition bypass on the device tier. See lib/device-auth.
  const auth = verifyDeviceRequest(req, rawText);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  let body: z.infer<typeof schema>;
  try { body = schema.parse(JSON.parse(rawText)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  if (body.direction !== "CREDIT")
    return NextResponse.json({ error: "only CREDIT alerts reconcile pay-ins" }, { status: 400 });

  // Server-side OTP/auth filter (defence in depth; the device should filter too).
  if (isAuthMessage(body.raw) || isAuthMessage(body.narration))
    return NextResponse.json({ ok: true, outcome: "REJECTED", detail: "auth/OTP message ignored" });

  try {
    const r = await ingestTxnAlert(body);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
