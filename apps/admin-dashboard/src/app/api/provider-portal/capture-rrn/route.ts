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

    // On-demand server-side resolve — try this BEFORE queuing a device request. A "no RRN"
    // credit is often the redundant twin of a sibling that ALREADY carries the 12-digit RRN:
    // the same payment seen on two channels (e.g. a GPay "payment received" push with no RRN,
    // plus the on-device screen capture that DID read the RRN) that failed to auto-merge
    // because they arrived hours apart or the push carried no VPA to match on. If EXACTLY ONE
    // such complementary sibling exists for the same merchant+amount, this row is a duplicate:
    // fold it out (mark DUPLICATE — drops it off the list and stops double-counting the gross)
    // and close the request. No device round-trip, and it works even when the phone is offline.
    if (alert.merchant_id) {
      const sibling = await rows<{ id: string; utr: string }>(
        "vendorGateway",
        `SELECT id::text, utr FROM vendor_txn_alerts
          WHERE id <> $1::uuid AND merchant_id = $2 AND amount = $3::numeric
            AND utr ~ '^[0-9]{12}$' AND COALESCE(outcome,'') <> 'DUPLICATE'
            AND created_at >= now() - interval '3 days'
          ORDER BY created_at DESC LIMIT 2`,
        [alert.id, alert.merchant_id, alert.amount],
      ).catch(() => []);
      if (sibling.length === 1) {
        await rows(
          "vendorGateway",
          `UPDATE vendor_txn_alerts
              SET outcome = 'DUPLICATE',
                  detail = COALESCE(detail,'') || ' · folded into ' || $2 || ' (on-demand Get RRN: RRN already captured on sibling)'
            WHERE id = $1::uuid`,
          [alert.id, sibling[0].id],
        ).catch(() => {});
        // Nothing left to capture for this credit — close any open request against it.
        await rows(
          "vendorGateway",
          `UPDATE vendor_capture_requests SET status = 'DONE', fulfilled_at = now()
            WHERE alert_id = $1::uuid AND status IN ('PENDING','SENT')`,
          [alert.id],
        ).catch(() => {});
        return NextResponse.json({ ok: true, status: "RESOLVED", rrn: sibling[0].utr,
          detail: "RRN already captured on a sibling credit; folded the duplicate" });
      }
    }

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
