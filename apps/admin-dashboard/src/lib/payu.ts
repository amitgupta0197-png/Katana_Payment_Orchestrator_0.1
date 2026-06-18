// Real PayU hosted-checkout adapter.
//
// Katana holds the merchant's PayU MID Key + Salt (gateway_mid in the vault) and
// builds a proper PayU _payment request on the merchant's behalf, then redirects
// the customer's browser to PayU's hosted page. PayU posts the result back to
// Katana's return endpoint, which verifies the response hash and forwards the
// customer to the merchant's success/failure URL.
//
// Request hash : sha512(key|txnid|amount|productinfo|firstname|email|udf1..5||||||salt)
// Response hash: sha512([additionalCharges|]salt|status|<reversed udf/reserved>|email|firstname|productinfo|amount|txnid|key)

import { createHash } from "crypto";
import type { GatewayMid } from "@/lib/gateway-creds";

export function payuPaymentUrl(env?: string): string {
  return (env ?? "TEST").toUpperCase() === "PROD"
    ? "https://secure.payu.in/_payment"
    : "https://test.payu.in/_payment";
}

export interface PayuOrder {
  txnid: string; amount: string; productinfo: string;
  firstname: string; email: string; phone: string;
  surl: string; furl: string;
}

export function payuRequestHash(mid: GatewayMid, o: PayuOrder): string {
  // 10 empty positional fields (udf1..5 + reserved) between email and salt.
  const seq = [mid.key, o.txnid, o.amount, o.productinfo, o.firstname, o.email,
               "", "", "", "", "", "", "", "", "", "", mid.salt].join("|");
  return createHash("sha512").update(seq).digest("hex");
}

export function payuFields(mid: GatewayMid, o: PayuOrder): Record<string, string> {
  return {
    key: mid.key, txnid: o.txnid, amount: o.amount, productinfo: o.productinfo,
    firstname: o.firstname, email: o.email, phone: o.phone,
    surl: o.surl, furl: o.furl, hash: payuRequestHash(mid, o),
    service_provider: "payu_paisa",
  };
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Auto-submitting HTML page that POSTs the customer's browser to PayU.
export function payuAutoSubmitForm(mid: GatewayMid, o: PayuOrder): string {
  const url = payuPaymentUrl(mid.env);
  const inputs = Object.entries(payuFields(mid, o))
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}"/>`).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Redirecting to PayU…</title></head>
<body onload="document.forms[0].submit()">
<p style="font-family:sans-serif">Redirecting to secure payment…</p>
<form method="post" action="${esc(url)}">
${inputs}
<noscript><button type="submit">Continue to payment</button></noscript>
</form></body></html>`;
}

// Verify the hash PayU posts back to surl/furl.
export function payuResponseHash(mid: GatewayMid, p: {
  status: string; email: string; firstname: string; productinfo: string;
  amount: string; txnid: string; additionalCharges?: string;
}): string {
  // Mirror of the request: 10 empty positional fields, but with salt+status
  // moved to the front and key to the end.
  const core = [mid.salt, p.status, ...Array(10).fill(""),
                p.email, p.firstname, p.productinfo, p.amount, p.txnid, mid.key];
  const seq = p.additionalCharges ? [p.additionalCharges, ...core] : core;
  return createHash("sha512").update(seq.join("|")).digest("hex");
}
