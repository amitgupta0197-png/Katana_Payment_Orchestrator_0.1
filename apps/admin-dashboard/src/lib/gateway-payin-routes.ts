// The shared bodies of each gateway's pay-in routes:
//   POST /api/gateway/<gateway>/webhook   server-to-server events; answers 200 JSON
//   GET|POST /api/gateway/<gateway>/return  the customer's browser coming back; answers a redirect
//
// Both only identify the order. Where the gateway signs its events the signature must match
// the merchant's credentials, but either way the order is settled from the gateway's own status
// API (lib/gateway-payin), so a forged "paid" callback can't mark anything paid.

import { NextResponse } from "next/server";
import type { GatewayMid } from "@/lib/gateway-creds";
import type { GatewayId } from "@/lib/pg-catalog";
import { checkGatewayPayin, checkoutReturnDest, gatewayOrderOwner, gatewayPayinFor } from "@/lib/gateway-payin";
import { publicBase } from "@/lib/payin-providers/types";
import { recordSecurityEvent } from "@/lib/security-event";
import { outcomeOf, recordGatewayWebhook } from "@/lib/gateway-webhook-log";

export interface WebhookBody { raw: string; json: Record<string, any> | null; form: Record<string, string> | null }

export async function readBody(req: Request): Promise<WebhookBody> {
  const raw = await req.text().catch(() => "");
  if (!raw) return { raw, json: null, form: null };
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object") return { raw, json: j, form: null };
  } catch { /* form */ }
  const form = Object.fromEntries(new URLSearchParams(raw));
  const has = Object.keys(form).length > 0;
  return { raw, json: has ? form : null, form: has ? form : null };
}

export async function handlePayinWebhook(req: Request, input: {
  provider: GatewayId;
  txnidOf: (b: WebhookBody) => string;
  /** true = signed correctly, false = bad signature, null = nothing to check with. */
  verify: (mid: GatewayMid, b: WebhookBody, headers: Headers) => boolean | null;
  /** Added to every 200 answer: a gateway that retries until it reads its own word (PayAtom). */
  ack?: Record<string, string>;
}) {
  const ok = (body: Record<string, unknown>) => NextResponse.json({ ...body, ...(input.ack ?? {}) });
  const b = await readBody(req);
  if (!b.json) return NextResponse.json({ ok: false, error: "empty body" }, { status: 400 });
  const txnid = input.txnidOf(b);
  // Every event that arrives is recorded (lib/gateway-webhook-log), whatever comes of it.
  const seen = { gateway: input.provider, txnId: txnid || null };
  if (!txnid) {
    // Field names only (never values): shows where this gateway puts its order reference.
    const keysOf = (o: unknown) => (o && typeof o === "object" ? Object.keys(o).join(",") : "");
    console.warn(`[gateway-webhook] ${input.provider} event with no order reference; keys=${keysOf(b.json)} data.keys=${keysOf((b.json as any)?.data)}`);
    recordGatewayWebhook({ ...seen, outcome: "IGNORED" });
    return ok({ ok: true, ignored: "no order reference" });
  }
  const owner = await gatewayOrderOwner(input.provider, txnid);
  if (!owner) {
    recordGatewayWebhook({ ...seen, outcome: "UNKNOWN_ORDER" });
    return ok({ ok: true, ignored: "unknown order", txn_id: txnid });
  }
  // The account the order was created on signs its events (lib/mid-switch).
  const gw = await gatewayPayinFor(owner.merchantCode, owner.vaultLabel);
  if (!gw || gw.mid.gateway !== input.provider) {
    recordGatewayWebhook({ ...seen, merchantId: owner.merchantCode, outcome: "NOT_CONNECTED" });
    return ok({ ok: true, ignored: "gateway not connected", txn_id: txnid });
  }
  const signed = input.verify(gw.mid, b, req.headers);
  if (signed === false) {
    recordGatewayWebhook({ ...seen, merchantId: owner.merchantCode, signatureOk: false, outcome: "BAD_SIGNATURE" });
    await recordSecurityEvent({ risk: "BAD_SIGNATURE", detail: `pay-in webhook from ${input.provider} for ${owner.merchantCode}, order ${txnid}` });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const r = await checkGatewayPayin({ provider: input.provider, txnid, merchantCode: owner.merchantCode, source: "webhook" });
  recordGatewayWebhook({ ...seen, merchantId: owner.merchantCode, signatureOk: signed, outcome: outcomeOf(r), status: r.status });
  return ok({ ok: true, txn_id: txnid, status: r.status, applied: r.applied, ...(r.reason ? { note: r.reason } : {}) });
}

function redirectTo(dest: string | null, params: Record<string, string>): NextResponse {
  let u: URL;
  try { u = new URL(dest || `${publicBase()}/`); } catch { u = new URL(`${publicBase()}/`); }
  if (!/^https?:$/.test(u.protocol)) u = new URL(`${publicBase()}/`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return NextResponse.redirect(u.toString(), 303);
}

export async function handlePayinReturn(req: Request, provider: GatewayId) {
  // Katana puts the txnid on every return URL it gives a gateway.
  const txnid = new URL(req.url).searchParams.get("txnid") ?? "";
  if (!txnid) return redirectTo(null, { status: "UNKNOWN", error: "missing_txnid" });
  const owner = await gatewayOrderOwner(provider, txnid);
  if (!owner) return redirectTo(null, { txnid, status: "UNKNOWN", error: "unknown_txn" });

  const r = await checkGatewayPayin({ provider, txnid, merchantCode: owner.merchantCode, source: "return" }).catch(() => null);
  if (owner.kind === "payin") {
    return redirectTo(owner.dest, { txnid, status: r?.status === "SUCCESS" || r?.status === "FAILED" ? r.status : "PENDING" });
  }
  const d = await checkoutReturnDest(txnid);
  return redirectTo(d.dest, { txnid, status: d.status });
}
