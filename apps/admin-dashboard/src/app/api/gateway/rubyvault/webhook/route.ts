// POST /api/gateway/rubyvault/webhook — RubyVault pay-in callbacks (the transaction object,
// optionally wrapped in { data }). RubyVault takes this URL once at onboarding, not per order.
// A present signature must match the merchant's secret; RubyVault's status API decides the outcome.
import { NextResponse } from "next/server";
import { handlePayinWebhook } from "@/lib/gateway-payin-routes";
import { rubyvaultCallbackOk, rubyvaultTxn } from "@/lib/payin-providers/rubyvault";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handlePayinWebhook(req, {
    provider: "RUBYVAULT",
    txnidOf: (b) => String(rubyvaultTxn(b.json).requestId ?? ""),
    verify: (mid, b) => rubyvaultCallbackOk(b.json, mid.salt),
  });
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
