// POST /api/v1/paytm-email — ingest a Paytm "Payment Received" email.
//
// A mail forwarder (Gmail push/Apps Script, IMAP poller, or manual paste) posts the
// email's { from, subject, text }. We parse amount + Order ID + payer VPA and feed the
// same reconciler as the device alerts (source=EMAIL). The email has no RRN — the Order
// ID is the unique key and the input for a later Paytm Status-API RRN lookup.
//
// Public route (device/forwarder-authenticated, sandbox header), whitelisted in
// middleware alongside /api/v1/txn-alert.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { ingestTxnAlert } from "@/lib/txn-reconcile";
import { parsePaytmEmail } from "@/lib/paytm-email";

export const dynamic = "force-dynamic";

const schema = z.object({
  from: z.string().max(200).optional(),
  subject: z.string().max(400).optional(),
  text: z.string().max(100_000),
  merchant_id: z.string().max(120).optional(),
  device_id: z.string().max(120).optional(),
});

export async function POST(req: Request) {
  const sandbox = req.headers.get("x-sandbox") === "1";
  if (!sandbox) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: z.infer<typeof schema>;
  try { body = schema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  const parsed = parsePaytmEmail({ from: body.from, subject: body.subject, text: body.text });
  if (!parsed) return NextResponse.json({ ok: true, outcome: "IGNORED", detail: "not a Paytm payment email" });

  try {
    const r = await ingestTxnAlert({
      source: "EMAIL",
      device_id: body.device_id,
      merchant_id: body.merchant_id,
      bank: "PAYTM",
      sender: "no-reply@paytm.com",
      direction: "CREDIT",
      amount: parsed.amount,
      order_ref: parsed.orderRef,
      payer_vpa: parsed.payerVpa ?? undefined,
      // Stable idempotency key so re-polling the same email never double-posts.
      nonce: `paytm-email:${parsed.orderRef}`,
      parser_version: "paytm-email-1.0",
      raw: `PAYTM email amt=${parsed.amount} order=${parsed.orderRef} payer=${parsed.payerVpa ?? "?"} time=${parsed.eventTime ?? "?"}`,
    });
    return NextResponse.json({ ok: true, parsed, ...r });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
