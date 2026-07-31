// POST /api/provider-portal/capture-rrn — raise an on-demand RRN capture request
// against a "no RRN" VPA credit. The agent polls /api/v1/capture-rrn, prompts the
// merchant (or, on a Shizuku device, executes) the Paytm Copy tap, and the request
// auto-closes when the 12-digit RRN lands on the alert.
//   PROVIDER / SUPER_ADMIN only (session-gated; middleware restricts /api/provider-portal/*).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

const schema = z.object({ alert_id: z.string().uuid() });

export async function POST(req: Request) {
  const g = await gateOrResponse(["PROVIDER", "SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;

  let body: z.infer<typeof schema>;
  try { body = schema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  try {
    // Load the target credit and confirm it is in the caller's scope. A PROVIDER may
    // only request captures for credits tagged to one of their branches.
    const alert = (await rows<{ id: string; merchant_id: string | null; amount: number; utr: string | null; payer_vpa: string | null }>(
      "vendorGateway",
      `SELECT id::text, merchant_id, amount::float AS amount, utr, payer_vpa
         FROM vendor_txn_alerts WHERE id = $1::uuid`,
      [body.alert_id],
    ))[0];
    if (!alert) return NextResponse.json({ error: "credit not found" }, { status: 404 });

    if (s.persona === "PROVIDER") {
      const codes = await resolveProviderMerchants(s);
      if (!alert.merchant_id || !codes.includes(alert.merchant_id))
        return NextResponse.json({ error: "out of scope" }, { status: 403 });
    }

    // Already has its RRN → nothing to capture.
    if (alert.utr && /^\d{12}$/.test(alert.utr))
      return NextResponse.json({ ok: true, status: "DONE", detail: "RRN already present" });

    // Insert an open request unless one already exists for this credit — a repeat press
    // is a no-op (the partial-unique index also enforces this at the DB level).
    await rows(
      "vendorGateway",
      `INSERT INTO vendor_capture_requests (alert_id, merchant_id, amount, payer_vpa, requested_by)
       SELECT $1::uuid, $2, $3, $4, $5
        WHERE NOT EXISTS (SELECT 1 FROM vendor_capture_requests
                           WHERE alert_id = $1::uuid AND status IN ('PENDING','SENT'))`,
      [body.alert_id, alert.merchant_id, alert.amount, alert.payer_vpa, s.email ?? s.persona],
    );

    return NextResponse.json({ ok: true, status: "PENDING" });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
