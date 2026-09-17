// POST /api/gateway/poolpay/webhook — PoolPay pay-in notifications (form or JSON with HASH).
// A present HASH must match the merchant's secret; PoolPay's status enquiry decides the outcome.
// PoolPay expects {"STATUS":"TRUE"} back.
import { NextResponse } from "next/server";
import { handlePayinWebhook } from "@/lib/gateway-payin-routes";
import { poolpayPayinHashOk } from "@/lib/payin-providers/poolpay";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const res = await handlePayinWebhook(req, {
    provider: "POOLPAY",
    txnidOf: (b) => String(b.json?.ORDER_ID ?? ""),
    verify: (mid, b) => {
      const p = Object.fromEntries(Object.entries(b.json ?? {}).map(([k, v]) => [k, v == null ? "" : String(v)]));
      return p.HASH ? poolpayPayinHashOk(p, mid.salt) : null;
    },
  });
  const body = await res.json().catch(() => ({}));
  return NextResponse.json({ STATUS: res.status === 200 ? "TRUE" : "FALSE", ...body }, { status: res.status });
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
