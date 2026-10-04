// POST /api/gateway/payatom/webhook — PayAtom pay-in callbacks, posted to the callback URL PayAtom
// set for the PID at onboarding. A callback is believed only when its post_hash decrypts to
// md5(order_id + received_amount + status + secret); even then it only names the order, and
// PayAtom's status API decides the outcome. PayAtom retries until it reads {"acknowledge": "yes"}
// with HTTP 200, so every 200 carries it (a bad hash is answered 401 and retried).
import { NextResponse } from "next/server";
import { handlePayinWebhook } from "@/lib/gateway-payin-routes";
import { payatomBodyOk } from "@/lib/payin-providers/payatom";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handlePayinWebhook(req, {
    provider: "PAYATOM",
    txnidOf: (b) => String(b.json?.order_id ?? ""),
    verify: (mid, b) => payatomBodyOk(b.json ?? {}, mid.salt) ?? false,   // PayAtom always sends a hash
    ack: { acknowledge: "yes" },
  });
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
