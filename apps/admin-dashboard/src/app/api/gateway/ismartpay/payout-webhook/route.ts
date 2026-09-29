// POST /api/gateway/ismartpay/payout-webhook — iSmartPay payout notifications. iSmartPay support
// sets this URL once per account. Unsigned, so the body is only a hint: iSmartPay's status API
// decides (lib/provider-payout-webhook).
//
// iSmartPay looks payouts up by its own transaction id. If the create call never answered, Katana
// doesn't have that id yet; it is taken from the callback only after iSmartPay's status API
// confirms the id belongs to this payout.
import { NextResponse } from "next/server";
import { rows } from "@/lib/pg";
import { providerCreds } from "@/lib/payout-providers";
import { loadProviderPayout } from "@/lib/provider-payout-order";
import { handleProviderPayoutWebhook, readWebhookBody } from "@/lib/provider-payout-webhook";

export const dynamic = "force-dynamic";

async function learnTransactionId(ref: string, transactionId: string): Promise<void> {
  const o = await loadProviderPayout("txn_ref", ref, "ISMARTPAY");
  if (!o || o.provider_ref) return;
  const active = await providerCreds("ISMARTPAY", o.merchant_id);
  if (!active) return;
  const r = await active.connector.status(active.creds, ref, { createdAt: new Date(o.created_at), providerRef: transactionId, timeoutMs: 6_000 });
  if (!r.ok || !r.data.found || r.data.ref !== ref) return;
  await rows("fifo", `UPDATE fifo_orders SET provider_ref=$2 WHERE id=$1::uuid AND provider_ref IS NULL`, [o.id, transactionId]).catch(() => {});
}

export async function POST(req: Request) {
  const { json: body } = await readWebhookBody(req);
  if (!body) return NextResponse.json({ ok: false, error: "empty body" }, { status: 400 });
  const ref = String(body.order_id ?? "");
  const transactionId = body.transaction_id ? String(body.transaction_id) : null;
  if (ref && transactionId) await learnTransactionId(ref, transactionId).catch(() => {});
  return handleProviderPayoutWebhook({
    provider: "ISMARTPAY",
    ref,
    providerRef: transactionId,
    event: String(body.status_code ?? "").toUpperCase(),
    verify: () => null,
  });
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
