// Status-intelligence background poller. A scheduler (systemd timer / cron) hits
// this every ~15s with the shared x-cron-key. It sweeps every non-terminal Katana Pay
// pay-in, applies the shared resolver (final-status lock + sandbox decision +
// pending-expiry), and persists any status change. This is the automated
// equivalent of the per-order status enquiry, so orders settle/expire without a
// client polling them. Whitelisted in middleware (PUBLIC_API).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { resolveKatanaStatus, genRrn } from "@/lib/katana-pay";
import { sendPayinCallback } from "@/lib/merchant-callback";
import { beat } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const key = process.env.FIFO_CRON_KEY;
  if (!key) return NextResponse.json({ error: "cron disabled (FIFO_CRON_KEY unset)" }, { status: 503 });
  if (req.headers.get("x-cron-key") !== key) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  try {
    const pending = await rows<any>("vendorGateway", `
      SELECT id::text, amount, status, livemode,
             EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
        FROM vendor_payin_orders
       WHERE vendor = 'KATANA' AND status NOT IN ('SUCCESS','SUCCEEDED','FAILED','EXPIRED')
         AND COALESCE((meta->>'hold')::boolean, false) = false   -- held orders need manual confirm
         AND COALESCE(meta->>'review', '') <> 'PROOF_SUBMITTED'  -- so do orders with a payment proof (autoResolvePaused)
       ORDER BY created_at ASC LIMIT 1000
    `).catch(() => []);

    let settled = 0, failed = 0, expired = 0, swept = 0;
    for (const o of pending) {
      const amountMinor = Math.round(Number(o.amount) * 100);
      // Sandbox amount rules apply to test orders only; a live order only ever expires here.
      const d = resolveKatanaStatus(o.status, amountMinor, o.age_seconds, o.livemode !== false);
      if (!d.changed) continue;
      const rrn = d.status === "SUCCESS" ? genRrn(o.id) : null;
      // The list above is a snapshot: an order confirmed since then is final and must not be
      // written over (a paid order turned EXPIRED). The status guard makes the write a no-op.
      const moved = await rows<{ id: string }>("vendorGateway", `
        UPDATE vendor_payin_orders
           SET status = $2, response_code = $3, rrn = COALESCE($4, rrn), updated_at = now()
         WHERE id = $1::uuid AND status NOT IN ('SUCCESS','SUCCEEDED','FAILED','EXPIRED')
        RETURNING id::text
      `, [o.id, d.status, d.response_code, rrn]).catch(() => []);
      if (!moved.length) continue;
      sendPayinCallback(o.id).catch(() => {});   // notify merchant of the terminal status
      swept++;
      if (d.status === "SUCCESS") settled++;
      else if (d.status === "FAILED") failed++;
      else if (d.status === "EXPIRED") expired++;
    }

    // CALLBACK BACKSTOP. Every path that makes an order final sends the callback itself, but as
    // a fire-and-forget step after the status write: a restart or a failed outbox write in
    // between leaves a final order whose merchant was never told. This picks those up — an
    // order with no callback record at all, one whose callback could not be queued, and a paid
    // order whose merchant has only ever been told "Expired" or "Failed". Orders final for under a minute
    // are left to the inline send; nothing older than a day is touched.
    const owed = await rows<{ id: string }>("vendorGateway", `
      SELECT id::text FROM vendor_payin_orders
       WHERE vendor = 'KATANA' AND merchant_id IS NOT NULL
         AND status IN ('SUCCESS','SUCCEEDED','FAILED','EXPIRED')
         AND updated_at BETWEEN now() - interval '24 hours' AND now() - interval '60 seconds'
         AND (meta->'callback' IS NULL
              OR meta->'callback'->>'skipped' = 'not queued'
              OR (status IN ('SUCCESS','SUCCEEDED') AND meta->'callback'->>'status' IN ('Expired','Failed')))
       ORDER BY updated_at ASC LIMIT 25
    `).catch(() => []);
    let renotified = 0;
    for (const o of owed) {
      const r = await sendPayinCallback(o.id).catch(() => ({ sent: false }));
      if (r.sent) renotified++;
    }
    const out = { scanned: pending.length, swept, settled, failed, expired, renotified };
    await beat("status-sweep", 60, true, out);
    return NextResponse.json({ ok: true, ...out });
  } catch (err) {
    await beat("status-sweep", 60, false, { error: (err as Error).message });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
