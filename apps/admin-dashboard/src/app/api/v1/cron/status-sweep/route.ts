// Status-intelligence background poller. A scheduler (systemd timer / cron) hits
// this every ~15s with the shared x-cron-key. It sweeps every non-terminal PoolPay
// pay-in, applies the shared resolver (final-status lock + sandbox decision +
// pending-expiry), and persists any status change. This is the automated
// equivalent of the per-order status enquiry, so orders settle/expire without a
// client polling them. Whitelisted in middleware (PUBLIC_API).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { resolvePoolPay, genRrn } from "@/lib/poolpay";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const key = process.env.FIFO_CRON_KEY;
  if (!key) return NextResponse.json({ error: "cron disabled (FIFO_CRON_KEY unset)" }, { status: 503 });
  if (req.headers.get("x-cron-key") !== key) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  try {
    const pending = await rows<any>("vendorGateway", `
      SELECT id::text, amount, status,
             EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
        FROM vendor_payin_orders
       WHERE vendor = 'POOLPAY' AND status NOT IN ('SUCCESS','SUCCEEDED','FAILED','EXPIRED')
       ORDER BY created_at ASC LIMIT 1000
    `).catch(() => []);

    let settled = 0, failed = 0, expired = 0, swept = 0;
    for (const o of pending) {
      const amountMinor = Math.round(Number(o.amount) * 100);
      const d = resolvePoolPay(o.status, amountMinor, o.age_seconds);
      if (!d.changed) continue;
      const rrn = d.status === "SUCCESS" ? genRrn(o.id) : null;
      await rows("vendorGateway", `
        UPDATE vendor_payin_orders
           SET status = $2, response_code = $3, rrn = COALESCE($4, rrn), updated_at = now()
         WHERE id = $1::uuid
      `, [o.id, d.status, d.response_code, rrn]).catch(() => {});
      swept++;
      if (d.status === "SUCCESS") settled++;
      else if (d.status === "FAILED") failed++;
      else if (d.status === "EXPIRED") expired++;
    }
    return NextResponse.json({ ok: true, scanned: pending.length, swept, settled, failed, expired });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
