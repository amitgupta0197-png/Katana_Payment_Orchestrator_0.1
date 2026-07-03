// PUBLIC PoolPay payment-page status endpoint (no session — the order id in the
// URL is the capability, same model as a hosted checkout link). Returns only the
// fields the customer-facing payment page needs: amount, status, deeplinks, QR.
// Whitelisted in middleware (PUBLIC_API_PREFIX).
//
// Supports long-polling: GET ...?wait=1 holds the request until the order reaches a
// terminal state (or a safe timeout), re-checking every ~500ms. This lets the
// customer pay page flip to "Payment received" and close the QR within ~0.5s of the
// credit being confirmed, instead of waiting for the next fixed client poll. Callers
// without ?wait=1 (e.g. the ops cockpit) keep the original immediate behaviour.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { resolvePoolPay, genRrn, POOLPAY_TERMINAL, autoResolvePaused } from "@/lib/poolpay";
import { sendPayinCallback } from "@/lib/merchant-callback";

export const dynamic = "force-dynamic";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WAIT_BUDGET_MS = 25_000; // < nginx proxy_read_timeout (60s); leaves headroom
const WAIT_TICK_MS = 500;      // DB re-check cadence while holding the request

interface StatusPayload {
  order_id: string; amount: number; currency_code: string; status: string;
  terminal: boolean; proof_submitted: boolean; rrn: string | null;
  mode: string; deeplinks: unknown; upi_intent: unknown; return_url: string | null;
}

// Read the order's current public status, running the same age-based auto-resolution
// (pending-expiry) the poll has always done. Returns null when the order is absent.
async function readOrderStatus(id: string): Promise<StatusPayload | null> {
  const found = await rows<any>("vendorGateway", `
    SELECT id::text, order_id, amount, currency_code, COALESCE(rrn,'') AS rrn,
           status, meta, EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
      FROM vendor_payin_orders
     WHERE id = $1::uuid AND vendor = 'POOLPAY'
  `, [id]);
  if (!found.length) return null;

  let order = found[0];
  if (!autoResolvePaused(order.meta)) { // high-amount holds + proofs await manual review
    const amountMinor = Math.round(Number(order.amount) * 100);
    const decision = resolvePoolPay(order.status, amountMinor, order.age_seconds);
    if (decision.changed) {
      const rrn = decision.status === "SUCCESS" ? genRrn(order.id) : null;
      const upd = await rows<any>("vendorGateway", `
        UPDATE vendor_payin_orders
           SET status = $2, response_code = $3, rrn = COALESCE($4, rrn), updated_at = now()
         WHERE id = $1::uuid
        RETURNING id::text, order_id, amount, currency_code, COALESCE(rrn,'') AS rrn, status, meta
      `, [order.id, decision.status, decision.response_code, rrn]);
      order = upd[0];
      // Auto-resolution just flipped this order terminal — fire the merchant
      // status callback (idempotent; no-op if already sent or no target).
      if (POOLPAY_TERMINAL.has(order.status)) sendPayinCallback(order.id).catch(() => {});
    }
  }

  const meta = order.meta ?? {};
  return {
    order_id: order.order_id,
    amount: Number(order.amount),
    currency_code: order.currency_code,
    status: order.status,
    terminal: POOLPAY_TERMINAL.has(order.status),
    proof_submitted: meta.review === "PROOF_SUBMITTED",
    rrn: order.rrn || null,
    mode: meta.mode ?? "QR",
    deeplinks: meta.deeplinks ?? null,
    upi_intent: meta.upi_intent ?? null,
    return_url: meta.return_url ?? null,   // browser redirect target after payment
  };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Guard against non-uuid ids hitting the DB with a cast error.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const wait = new URL(req.url).searchParams.get("wait") === "1";

  try {
    let payload = await readOrderStatus(id);
    if (!payload) return NextResponse.json({ error: "not found" }, { status: 404 });

    // Long-poll: hold until terminal (payment received / failed / expired) or the
    // budget elapses, bailing immediately if the client navigates away.
    if (wait && !payload.terminal) {
      const deadline = Date.now() + WAIT_BUDGET_MS;
      while (Date.now() < deadline && !payload.terminal && !req.signal.aborted) {
        await sleep(WAIT_TICK_MS);
        const next = await readOrderStatus(id);
        if (!next) break;
        payload = next;
      }
    }

    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
