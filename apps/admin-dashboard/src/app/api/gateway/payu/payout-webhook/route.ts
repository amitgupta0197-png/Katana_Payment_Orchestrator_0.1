// POST /api/gateway/payu/payout-webhook — PayU Payouts events (TRANSFER_SUCCESS / _FAILED /
// _REVERSED, LOW_BALANCE_ALERT, ...). One URL for every merchant; registered per merchant
// from the admin merchant page, which also sets the shared token PayU echoes back.
//
// PayU does not sign these events. Two things stand in for a signature:
//   1. the Authorization header must equal the token registered for that merchant, and
//   2. the body is only a hint (lib/provider-payout-webhook): PayU's status API decides.
import { NextResponse } from "next/server";
import { payoutWebhookTokenMatches, type PayuPayoutCreds } from "@/lib/payu-payout";
import { handleProviderPayoutWebhook, readWebhookBody } from "@/lib/provider-payout-webhook";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { json: body } = await readWebhookBody(req);
  if (!body) return NextResponse.json({ ok: false, error: "empty body" }, { status: 400 });
  const auth = req.headers.get("authorization");
  return handleProviderPayoutWebhook({
    provider: "PAYU",
    ref: String(body.merchantReferenceId ?? body.merchantRefId ?? ""),
    event: String(body.event ?? "").toUpperCase(),
    // Until the webhook is registered from Katana there is no token to check; the status
    // lookup is then the only check, and it is the one that matters.
    verify: ({ creds }) => {
      const c = creds as PayuPayoutCreds;
      return c.webhook_token ? payoutWebhookTokenMatches(c, auth) : null;
    },
  });
}

// PayU's dashboard pings the URL when you save it.
export async function GET() {
  return NextResponse.json({ ok: true });
}
