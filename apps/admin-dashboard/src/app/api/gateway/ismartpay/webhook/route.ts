// POST /api/gateway/ismartpay/webhook — iSmartPay pay-in notifications (the webhook_url Katana
// sends with each order). iSmartPay doesn't sign them, so the body only names the order;
// iSmartPay's status API decides the outcome.
import { NextResponse } from "next/server";
import { handlePayinWebhook } from "@/lib/gateway-payin-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handlePayinWebhook(req, {
    provider: "ISMARTPAY",
    txnidOf: (b) => String(b.json?.order_id ?? ""),
    verify: () => null,
  });
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
