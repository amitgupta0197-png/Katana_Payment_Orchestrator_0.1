// POST /api/v1/text-alert — ingest a raw text bank/UPI alert ("Payment received Rs.100
// … UPI Ref No 209…") from the Katana agent, parse it with the same parser as
// email ingest, and feed our reconciler + dashboard. Merchant comes from the ?m= query
// so the forwarder only needs a URL. Public (device-authenticated), whitelisted.

import { NextResponse } from "next/server";
import { parsePaymentEmail } from "@/lib/email-ingest";
import { ingestTxnAlert, isAuthMessage } from "@/lib/txn-reconcile";
import { verifyDeviceRequest } from "@/lib/device-auth";
import { pgError } from "@/lib/pg";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const merchant = new URL(req.url).searchParams.get("m") || undefined;
  const raw = await req.text();
  // Was unauthenticated (audit H4): require a device signature (or the sandbox bypass).
  const auth = verifyDeviceRequest(req, raw);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  let b: { clientAlertId?: string; body?: string; sender?: string; source?: string };
  try { b = JSON.parse(raw); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const body = String(b.body ?? "").trim();
  if (!body) return NextResponse.json({ ok: true, outcome: "EMPTY" });
  if (isAuthMessage(body)) return NextResponse.json({ ok: true, outcome: "REJECTED", detail: "auth/OTP" });

  const hit = parsePaymentEmail("", body);
  if (!hit) return NextResponse.json({ ok: true, outcome: "UNPARSED", detail: "not a credit" });

  const sender = b.sender ?? "";
  const bank = /phonepe/i.test(sender + body) ? "PHONEPE" : /paytm/i.test(sender + body) ? "PAYTM" : undefined;
  try {
    const r = await ingestTxnAlert({
      source: "NOTIFICATION",
      merchant_id: merchant,
      amount: hit.amount,
      utr: hit.utr ?? undefined,
      order_ref: hit.orderRef ?? undefined,
      payer_name: hit.payerName ?? undefined,
      payer_vpa: hit.payerVpa ?? undefined,
      sender: sender || "katana-agent",
      raw: body.slice(0, 2000),
      nonce: b.clientAlertId ?? undefined,   // idempotency — server dedupes on it
      bank,
      parser_version: "text-1.0",
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
