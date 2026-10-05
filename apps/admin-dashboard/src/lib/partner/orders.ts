// A partner's order (lib/partner): checked against the sub-merchant (status, flows, limits), then
// offered to the partner's bankers until one takes it. Each attempt is that banker's whole order
// path in the pay-in core (lib/katana-order: block, live mode, flow, limits, MIDs), so nothing a
// merchant order obeys is skipped. The order belongs to the banker that took it (its money and
// settlement go to the partner as for any merchant); its callback goes to the partner.

import { rows } from "@/lib/pg";
import { createKatanaOrder, passOverCode, readExistingOrder, PayinSetupError, type CreateKatanaOrderResult } from "@/lib/katana-order";
import type { PayuIntentClient } from "@/lib/payu-intent";
import { bankerOrder, passOverWords } from "@/lib/banker-switch";
import { bankerToday, getMembers, getSwitchSettings, providerBankers } from "@/lib/banker-switch-store";
import { raiseAlert } from "@/lib/ops-alert";
import { orderFlowFor, partnerOrderRefusal, partnerSigner, type OrderFlowName, type PartnerRefusal } from "@/lib/partner/rules";
import { logPartnerEvent, subTodayAmount, type PartnerRow, type SubMerchantRow } from "@/lib/partner/store";

/** The sub-merchant may not take this order (403 / 409 / 422 with the code). */
export class PartnerRefusalError extends Error {
  constructor(readonly refusal: PartnerRefusal) { super(refusal.message); }
}

/** The reference is already a different order of this partner (another sub-merchant or amount). */
export class PartnerReferenceError extends Error {
  constructor(reference: string, why: string) { super(`reference ${reference} already belongs to an order ${why}`); }
}

export interface PartnerOrderRequest {
  partner: PartnerRow;
  sub: SubMerchantRow;
  livemode: boolean;
  reference: string;
  amount: number;                 // rupees
  flow?: OrderFlowName | null;
  callbackUrl?: string | null;
  returnUrl?: string | null;
  customerPhone?: string | null;
  customerVpa?: string | null;
  client?: PayuIntentClient | null;
  metadata?: Record<string, string | number | boolean | null>;
  requestId?: string | null;
}

/** The order in which the partner's bankers are offered an order: its banker switch when on, else all of them. */
async function bankersFor(partner: PartnerRow, livemode: boolean): Promise<string[]> {
  const bankers = (await providerBankers(partner.provider_id)).map((b) => b.code);
  if (bankers.length < 2) return bankers;
  const settings = await getSwitchSettings(partner.provider_id);
  if (!settings.enabled) return bankers;
  const [members, today] = await Promise.all([getMembers(partner.provider_id, bankers), bankerToday(bankers, livemode)]);
  const order = bankerOrder(members, settings, new Date(), {
    ordersToday: Object.fromEntries(Object.entries(today).map(([b, t]) => [b, t.orders])),
  }).map((c) => c.banker);
  return order.length ? order : bankers;
}

export async function createPartnerOrder(r: PartnerOrderRequest): Promise<CreateKatanaOrderResult> {
  const signer = partnerSigner(r.partner.id);

  // A replay is answered first, as the order it was created as, if it is the same order.
  const prior = await readExistingOrder(r.reference, signer, r.livemode);
  if (prior) {
    const p = (await rows<{ sub: string | null; amount: string }>("vendorGateway",
      `SELECT partner_sub_merchant_id::text AS sub, amount::text AS amount FROM vendor_payin_orders WHERE id = $1::uuid`,
      [prior.order.id]))[0];
    if (p?.sub !== r.sub.id) throw new PartnerReferenceError(r.reference, "of another sub-merchant");
    if (Math.round(Number(p.amount) * 100) !== Math.round(r.amount * 100)) throw new PartnerReferenceError(r.reference, "of a different amount");
    return prior;
  }

  const refusal = partnerOrderRefusal({
    partner: r.partner, sub: r.sub, livemode: r.livemode, amount: r.amount,
    todayAmount: r.livemode && r.sub.daily_amount != null ? await subTodayAmount(r.sub.id) : 0,
  });
  if (refusal) throw new PartnerRefusalError(refusal);
  const f = orderFlowFor(r.sub.flows, r.flow ?? null);
  if (!f.ok) throw new PartnerRefusalError(f.refusal);

  const bankers = await bankersFor(r.partner, r.livemode);
  if (!bankers.length) throw new PayinSetupError("the partner account has no banker to take payments yet; contact Katana support");

  const passed: { banker: string; code: string }[] = [];
  let first: unknown = null;
  for (const banker of bankers) {
    try {
      return await createKatanaOrder({
        orderId: r.reference, amount: r.amount, currency: "INR", merchantId: banker, livemode: r.livemode,
        notifyUrl: r.callbackUrl ?? null, returnUrl: r.returnUrl ?? null,
        customerPhone: r.customerPhone ?? null, customerVpa: r.customerVpa ?? null, client: r.client ?? null,
        flow: f.flow, metadata: r.metadata, requestId: r.requestId ?? null,
        signedBy: signer,
        partner: {
          partnerId: r.partner.id, subMerchantId: r.sub.id, subCode: r.sub.sub_code, externalId: r.sub.external_id,
          ownGateway: r.partner.own_gateway,
        },
      });
    } catch (err) {
      const code = passOverCode(err);
      if (!code) throw err;
      passed.push({ banker, code });
      first ??= err;
    }
  }
  const words = passed.map((p) => ({ ...p, why: passOverWords(p.code) }));
  await logPartnerEvent(r.partner.id, "NONE_AVAILABLE", "system", { reference: r.reference, livemode: r.livemode, passed_over: words }, r.sub.id).catch(() => {});
  if (r.livemode) await raiseAlert({
    key: `partner:none:${r.partner.id}`, severity: "WARN", repeatMinutes: 30,
    title: `Partner ${r.partner.code}: no banker could take an order`,
    body: words.map((p) => `${p.banker} ${p.why}`).join("; "),
  }).catch(() => {});
  throw first;
}
