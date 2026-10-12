// Quasi-headless checkout (P2P method HEADLESS; rules in lib/headless): the banker's PhonePe /
// Paytm PG accounts saved for P2P, and the Pay tap that asks the chosen PSP for the UPI intent.
//
// An order is created with no PSP (lib/katana-order: meta.headless, no meta.gateway). The first
// Pay tap stamps the PSP onto the order exactly as an ordinary gateway order: meta.gateway (its
// txnid, which becomes vendor_txn_id), meta.mid.vault_label (the account: every later call about the
// order uses it, lib/gateway-creds orderVaultLabel), the links and channel_id. From then on the
// PSP's webhook, the pay-status poll and the verify sweep confirm it like any gateway order. The
// guarded UPDATE makes the tap one-time: a second tap gets the same link, never a second intent.

import { randomUUID } from "crypto";
import { rows } from "@/lib/pg";
import { getGatewayMid, type GatewayMid } from "@/lib/gateway-creds";
import { bankerGatewayAccounts } from "@/lib/mid-switch-store";
import { gatewayAccountChannel } from "@/lib/pg-catalog";
import { payinConnectorFor } from "@/lib/payin-providers";
import { payinProdEnabled, payinReturnUrl, payinWebhookUrl, type PayinConnector } from "@/lib/payin-providers/types";
import { assertGoLiveAllows } from "@/lib/gateway-golive";
import { PENDING_EXPIRY_SECONDS } from "@/lib/katana-pay";
import { HEADLESS_PSPS, asHeadlessPsp, pspAppLink, startRefusal, type HeadlessPsp } from "@/lib/headless";

export interface HeadlessAccount { psp: HeadlessPsp; vault_label: string; mid: GatewayMid; connector: PayinConnector }

/**
 * The banker's PhonePe / Paytm PG accounts saved for P2P that can issue a UPI intent, one per PSP
 * (its first account first). `live`: only live accounts the server may use.
 */
export async function headlessAccounts(code: string, live: boolean): Promise<HeadlessAccount[]> {
  const list = await bankerGatewayAccounts(code).catch(() => []);
  const out: HeadlessAccount[] = [];
  for (const a of list) {
    const psp = asHeadlessPsp(a.gateway);
    if (!psp || out.some((x) => x.psp === psp)) continue;
    const mid = await getGatewayMid(code, a.vault_label).catch(() => null);
    const connector = payinConnectorFor(mid);
    if (!mid || !connector?.upiIntent || gatewayAccountChannel(mid) !== "P2P") continue;
    if (live && (mid.env !== "PROD" || !payinProdEnabled(mid.gateway))) continue;
    out.push({ psp, vault_label: a.vault_label, mid, connector });
  }
  return HEADLESS_PSPS.flatMap((p) => out.filter((x) => x.psp === p));
}

export class HeadlessStartError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

interface OrderRow {
  id: string; order_id: string; merchant_id: string; amount: string; currency_code: string; status: string;
  meta: Record<string, any>; livemode: boolean; customer_vpa: string | null; customer_phone: string | null; age_seconds: number;
}

const read = (id: string) => rows<OrderRow>("vendorGateway", `
  SELECT id::text, order_id, merchant_id, amount::text, currency_code, status, meta, livemode, customer_vpa, customer_phone,
         EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
    FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'KATANA'`, [id]).then((r) => r[0] ?? null);

/**
 * The customer tapped Pay with `psp`: the app link to fire. Creates the UPI intent on the banker's
 * account for that PSP the first time; afterwards answers the same link. Never names the PG.
 */
export async function startHeadlessPayment(id: string, pspRaw: unknown, client: { ip: string; deviceInfo: string }):
  Promise<{ psp: HeadlessPsp; app: string; upi: string }> {
  const psp = asHeadlessPsp(pspRaw);
  if (!psp) throw new HeadlessStartError("BAD_PSP", "Choose PhonePe or Paytm.", 400);
  const o = await read(id);
  if (!o) throw new HeadlessStartError("NOT_FOUND", "This payment was not found.", 404);
  const h = o.meta?.headless ?? null;
  const chosen = asHeadlessPsp(h?.chosen);
  const refusal = startRefusal({
    headless: !!h, status: o.status, expired: o.age_seconds >= PENDING_EXPIRY_SECONDS, chosen, psp,
    available: Array.isArray(h?.psps) ? h.psps.map(asHeadlessPsp).filter(Boolean) as HeadlessPsp[] : [],
  });
  if (refusal) throw new HeadlessStartError(refusal.code, refusal.message);
  // Already started in this app: the same link again.
  if (chosen === psp && typeof h?.link?.app === "string") return { psp, app: h.link.app, upi: h.link.upi };

  // A test order never reaches a PSP: the sandbox link it was created with, in the chosen app.
  if (o.livemode === false) {
    const query = String(o.meta?.upi_intent ?? "").split("?").slice(1).join("?");
    const link = pspAppLink(psp, query);
    await stamp(o.id, { headless: { ...h, chosen: psp, link } });
    return { psp, ...link };
  }

  const acct = (await headlessAccounts(o.merchant_id, true)).find((a) => a.psp === psp);
  if (!acct) throw new HeadlessStartError("PSP_UNAVAILABLE", "This app can't be used for this payment right now. Try the other one.");
  const amount = Number(o.amount);
  // A live account still on its go-live checklist takes only small verification payments.
  await assertGoLiveAllows(o.merchant_id, acct.mid.gateway, amount, acct.vault_label).catch(() => {
    throw new HeadlessStartError("PSP_UNAVAILABLE", "This app can't take this payment right now. Try the other one.");
  });

  const txnid = `kp_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
  const r = await acct.connector.upiIntent!(acct.mid, {
    txnid, amountMinor: BigInt(Math.round(amount * 100)), currency: o.currency_code,
    productinfo: typeof h?.note === "string" ? h.note : `Order ${o.order_id}`,
    firstname: "Customer", email: "payments@katanapay.co", phone: o.customer_phone?.trim() || "9999999999",
    returnUrl: payinReturnUrl(acct.connector.id, txnid), notifyUrl: payinWebhookUrl(acct.connector.id),
    customerVpa: o.customer_vpa ?? null,
  }, client);
  if (!r.ok) {
    console.error(`[headless] ${acct.connector.id} intent failed for ${o.id}: ${r.error}`);
    throw new HeadlessStartError("START_FAILED", "Couldn't start the payment. Try again, or try the other app.", 502);
  }
  const link = pspAppLink(psp, r.data.intentQuery, r.data.appLinks ?? null);
  const gateway = {
    provider: acct.connector.id, txnid, payment_id: r.data.paymentId, env: acct.mid.env ?? "PROD",
    payee_vpa: new URLSearchParams(r.data.intentQuery).get("pa"),
  };
  const done = await rows<{ id: string }>("vendorGateway", `
    UPDATE vendor_payin_orders
       SET vendor_txn_id = $2, channel_id = $3, updated_at = now(),
           meta = meta || $4::jsonb
     WHERE id = $1::uuid AND status IN ('PENDING','INITIATED')
       AND COALESCE(meta->'gateway'->>'provider', '') = ''
    RETURNING id::text`, [o.id, txnid, acct.connector.id, JSON.stringify({
      gateway, mid: { vault_label: acct.vault_label, kind: "GATEWAY", how: "HEADLESS", reason: `customer chose ${psp}` },
      deeplinks: { upi: link.upi, paytm: psp === "PAYTM" ? link.app : "", phonepe: psp === "PHONEPE" ? link.app : "" },
      upi_intent: link.upi, qr_payload: link.upi,
      receiver_vpa: gateway.payee_vpa,
      integration: { source: acct.connector.id.toLowerCase(), env: gateway.env, live: true },
      headless: { ...h, chosen: psp, link, started_at: new Date().toISOString() },
    })]);
  if (!done.length) {
    // Another tap won the race: answer with what it stamped.
    const again = await read(id);
    const hh = again?.meta?.headless;
    if (asHeadlessPsp(hh?.chosen) === psp && typeof hh?.link?.app === "string") return { psp, app: hh.link.app, upi: hh.link.upi };
    throw new HeadlessStartError("NOT_PAYABLE", "This payment can't be started again.");
  }
  return { psp, ...link };
}

async function stamp(id: string, patch: Record<string, unknown>) {
  await rows("vendorGateway", `UPDATE vendor_payin_orders SET meta = meta || $2::jsonb, updated_at = now() WHERE id = $1::uuid`,
    [id, JSON.stringify(patch)]);
}
