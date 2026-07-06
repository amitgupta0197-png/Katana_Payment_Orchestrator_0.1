// GET /api/v1/capture-rrn — agent poll for open on-demand RRN capture requests.
//
// The forwarder device polls this on a short interval. It returns the merchant's open
// requests (raised from the dashboard's "Get RRN" button) and atomically flips any
// PENDING ones to SENT so a second device / poll doesn't re-issue them. A request stays
// returned (SENT) until the RRN lands (reconciler marks it DONE) or it ages out, so a
// missed delivery is retried on the next poll.
//
// Public route (device-authenticated, not session-gated; whitelisted in middleware).
// Auth mirrors /api/v1/txn-alert: `x-sandbox: 1` (sandbox forwarder) or an HMAC
// x-signature over the query string.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { signPayload } from "@/lib/fifo-notify";

export const dynamic = "force-dynamic";

// Requests older than this are considered stale and are not delivered (and are lazily
// expired). The merchant can always press the button again.
const MAX_AGE_MINUTES = 30;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const deviceId = url.searchParams.get("device_id") ?? "";
  const merchantId = url.searchParams.get("merchant_id") ?? "";

  // Auth: sandbox header, or HMAC over the raw query string.
  const sandbox = req.headers.get("x-sandbox") === "1";
  if (!sandbox) {
    const sig = req.headers.get("x-signature") ?? "";
    if (!sig || signPayload(url.search) !== sig)
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  if (!merchantId) return NextResponse.json({ commands: [] });

  try {
    // Lazily expire stale open requests for this merchant.
    await rows(
      "vendorGateway",
      `UPDATE vendor_capture_requests SET status = 'EXPIRED'
        WHERE merchant_id = $1 AND status IN ('PENDING','SENT')
          AND created_at < now() - ($2 || ' minutes')::interval`,
      [merchantId, String(MAX_AGE_MINUTES)],
    ).catch(() => []);

    // Claim PENDING → SENT (stamp the polling device) and read back every still-open
    // request for this merchant in one round-trip.
    const claimed = await rows<{ id: string }>(
      "vendorGateway",
      `UPDATE vendor_capture_requests
          SET status = 'SENT', device_id = COALESCE(device_id, $2), sent_at = COALESCE(sent_at, now())
        WHERE merchant_id = $1 AND status = 'PENDING'
        RETURNING id::text`,
      [merchantId, deviceId || null],
    ).catch(() => []);

    const open = await rows<{ id: string; alert_id: string; amount: number; payer_vpa: string | null }>(
      "vendorGateway",
      `SELECT id::text, alert_id::text, amount::float AS amount, payer_vpa
         FROM vendor_capture_requests
        WHERE merchant_id = $1 AND status = 'SENT'
        ORDER BY created_at DESC LIMIT 20`,
      [merchantId],
    ).catch(() => []);

    const commands = open.map((r) => ({
      id: r.id,
      type: "CAPTURE_RRN" as const,
      alert_id: r.alert_id,
      amount: r.amount,
      payer_vpa: r.payer_vpa,
    }));
    return NextResponse.json({ commands, claimed: claimed.length });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
