// PUBLIC Katana Pay payment-page status endpoint (no session — the order id in the
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
import { pgError } from "@/lib/pg";
import { readOrderStatus } from "@/lib/pay-status";

export const dynamic = "force-dynamic";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WAIT_BUDGET_MS = 25_000; // < nginx proxy_read_timeout (60s); leaves headroom
const WAIT_TICK_MS = 500;      // DB re-check cadence while holding the request

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
