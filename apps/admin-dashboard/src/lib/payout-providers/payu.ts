// PayU Payouts as a PayoutConnector. The API client itself is lib/payu-payout.

import {
  getPayuPayoutCreds, payuListTransfers, payuPayoutBalance, payuTransfer, payuTransferStatus,
  registerPayuPayoutWebhook, storePayuPayoutCreds, type PayuPayoutCreds, type PayuTransferState,
} from "@/lib/payu-payout";
import type { PayoutConnector, TransferState } from "@/lib/payout-providers/types";

function finalOf(s?: string): TransferState["final"] {
  if (s === "SUCCESS") return "SUCCESS";
  if (s === "FAILED") return "FAILED";
  if (s === "REVERSED") return "REVERSED";
  return null;
}

function toState(d: PayuTransferState & { merchantRefId?: string }): TransferState {
  if (!d.found) return { found: false };
  return {
    found: true, ref: d.merchantRefId, final: finalOf(d.status), status: d.status,
    providerRef: d.payuRef, bankRef: d.bankRef, amountMinor: d.amountMinor, msg: d.msg, raw: d.raw,
  };
}

export const payuConnector: PayoutConnector<PayuPayoutCreds> = {
  id: "PAYU",
  name: "PayU",
  rails: ["IMPS", "NEFT", "RTGS", "UPI"],
  creds: getPayuPayoutCreds,
  providerRefFor: (txnRef) => txnRef,
  txnRefFrom: (ref) => ref,

  async transfer(c, t) {
    const r = await payuTransfer(c, {
      merchantRefId: t.ref, amountMinor: t.amountMinor, rail: t.rail, purpose: t.purpose,
      beneficiaryName: t.beneficiaryName, accountNumber: t.accountNumber, ifsc: t.ifsc, vpa: t.vpa,
    });
    return r.ok ? { ok: true, data: {} } : r;
  },

  async status(c, ref, opts) {
    const r = await payuTransferStatus(c, ref, opts.createdAt, opts.timeoutMs);
    return r.ok ? { ok: true, data: toState(r.data) } : r;
  },

  async list(c, from, to) {
    const r = await payuListTransfers(c, from, to);
    return r.ok ? { ok: true, data: r.data.map((d) => ({ ...toState(d), ref: d.merchantRefId })) } : r;
  },

  balance: payuPayoutBalance,

  async registerWebhook(merchantCode, c) {
    const r = await registerPayuPayoutWebhook(c);
    if (!r.ok) return r;
    // Stored only after PayU took it: until then the old token is still the one PayU sends.
    await storePayuPayoutCreds(merchantCode, { ...c, webhook_token: r.data.token, webhook_registered_at: new Date().toISOString() });
    return { ok: true, data: { url: r.data.url } };
  },
};
