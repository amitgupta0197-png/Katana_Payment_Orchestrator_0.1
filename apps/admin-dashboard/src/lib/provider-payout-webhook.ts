// The common half of every gateway's payout webhook route.
//
// A webhook body is only a hint. The route finds the payout it names, checks the gateway's
// signature where the gateway signs, then asks the gateway's status API what happened
// (syncProviderPayout) and applies that. A forged "success" can't mark a payout paid.
//
// Gateways want a quick 2xx and retry otherwise, so the status lookup gets a short timeout; if
// it doesn't answer in time the sweep (cron/payu-payout-verify) finishes the job. Events Katana
// has nothing to do with (other transfers, account events) get a 200 so they aren't retried.

import { NextResponse } from "next/server";
import type { GatewayId } from "@/lib/pg-catalog";
import { payoutConnector, providerCreds, type ActivePayout } from "@/lib/payout-providers";
import { loadProviderPayout, syncProviderPayout } from "@/lib/provider-payout-order";

export async function readWebhookBody(req: Request): Promise<{ raw: string; json: Record<string, any> | null; form: Record<string, string> | null }> {
  const raw = await req.text().catch(() => "");
  if (!raw) return { raw, json: null, form: null };
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object") return { raw, json: j, form: null };
  } catch { /* fall through to form */ }
  const form = Object.fromEntries(new URLSearchParams(raw));
  return { raw, json: Object.keys(form).length ? form : null, form: Object.keys(form).length ? form : null };
}

export async function handleProviderPayoutWebhook(input: {
  provider: GatewayId;
  ref: string;                 // the gateway-side transfer reference
  providerRef?: string | null; // the gateway's own transfer id, when the event has no reference
  event: string;
  /** true = signature good, false = bad, null = this merchant has no way to check (unsigned). */
  verify: (a: ActivePayout) => boolean | null;
}) {
  const { provider, event } = input;
  let order = null;
  if (input.ref) order = await loadProviderPayout("txn_ref", payoutConnector(provider)!.txnRefFrom(input.ref), provider);
  if (!order && input.providerRef) order = await loadProviderPayout("provider_ref", input.providerRef, provider);
  if (!input.ref && !input.providerRef) return NextResponse.json({ ok: true, ignored: "no transfer reference", event });
  if (!order) return NextResponse.json({ ok: true, ignored: "unknown transfer", event });

  const active = await providerCreds(provider, order.merchant_id);
  if (!active) return NextResponse.json({ ok: true, ignored: "no payout credentials for this gateway", event });
  if (input.verify(active) === false)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const r = await syncProviderPayout(order, { hint: event || "WEBHOOK", timeoutMs: 6_000, minGapSeconds: 0 });
  return NextResponse.json({ ok: true, event, order_ref: order.order_ref, outcome: r.outcome });
}
