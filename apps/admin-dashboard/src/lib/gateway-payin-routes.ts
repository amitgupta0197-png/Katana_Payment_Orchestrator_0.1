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
}) {
  const b = await readBody(req);
  if (!b.json) return NextResponse.json({ ok: false, error: "empty body" }, { status: 400 });
  const txnid = input.txnidOf(b);
  if (!txnid) return NextResponse.json({ ok: true, ignored: "no order reference" });
  const owner = await gatewayOrderOwner(input.provider, txnid);
  if (!owner) return NextResponse.json({ ok: true, ignored: "unknown order", txn_id: txnid });
  const gw = await gatewayPayinFor(owner.merchantCode);
  if (!gw || gw.mid.gateway !== input.provider) return NextResponse.json({ ok: true, ignored: "gateway not connected", txn_id: txnid });
  if (input.verify(gw.mid, b, req.headers) === false)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const r = await checkGatewayPayin({ provider: input.provider, txnid, merchantCode: owner.merchantCode, source: "webhook" });
  return NextResponse.json({ ok: true, txn_id: txnid, status: r.status, applied: r.applied, ...(r.reason ? { note: r.reason } : {}) });
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
