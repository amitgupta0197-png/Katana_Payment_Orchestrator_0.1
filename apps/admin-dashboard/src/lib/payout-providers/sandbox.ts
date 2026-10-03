// Katana's own payout sandbox: where a payout made with a TEST key goes when the banker has no
// sandbox account at a payout gateway. Nothing leaves Katana; the amount decides the result,
// as it does for test pay-ins (lib/katana-pay):
//
//   paise .99  SUCCESS at once
//   paise .13  FAILED at once
//   otherwise  PROCESSING, then SUCCESS about SANDBOX_SETTLE_SECONDS after it was sent
//
// It is an ordinary PayoutConnector, so a test payout takes exactly the path a gateway payout
// does (lib/provider-payout-order): guarded status moves, the verify sweep settling one that is
// still in flight, the signed payout.status callback. It is never a banker's payout gateway: only
// createPayout picks it, and only for a test key (lib/fifo-payout).

import { createHash } from "crypto";
import { rows } from "@/lib/pg";
import type { GatewayId } from "@/lib/pg-catalog";
import type { PayoutConnector, TransferState } from "@/lib/payout-providers/types";

export const SANDBOX_PAYOUT = "SANDBOX";
export const SANDBOX_SETTLE_SECONDS = 10;

/** The sandbox's answer for a payout of this amount, this long after it was sent. Pure. */
export function sandboxOutcome(amountMinor: bigint, secondsSinceSent: number): { final: TransferState["final"]; status: string; msg?: string } {
  const paise = Number(amountMinor % 100n);
  if (paise === 13) return { final: "FAILED", status: "FAILED", msg: "Test payout declined: an amount ending in .13 always fails in test mode" };
  if (paise === 99 || secondsSinceSent >= SANDBOX_SETTLE_SECONDS) return { final: "SUCCESS", status: "SUCCESS" };
  return { final: null, status: "PROCESSING" };
}

/** A made-up bank reference for a sandbox payout, the same every time it is asked for. */
export function sandboxUtr(txnRef: string): string {
  return "SBX" + BigInt("0x" + createHash("sha256").update(txnRef).digest("hex").slice(0, 12)).toString().padStart(12, "0").slice(-9);
}

function state(txnRef: string, amountMinor: bigint, secondsSinceSent: number): TransferState {
  const o = sandboxOutcome(amountMinor, secondsSinceSent);
  return {
    found: true, ref: txnRef, final: o.final, status: o.status, providerRef: `SBX-${txnRef}`,
    bankRef: o.final === "SUCCESS" ? sandboxUtr(txnRef) : undefined, amountMinor, msg: o.msg,
    raw: { sandbox: true, status: o.status },
  };
}

export const sandboxConnector: PayoutConnector<{ env: "TEST" }> = {
  // Not a gateway in the catalog: lib/payout-providers looks it up by this id.
  id: SANDBOX_PAYOUT as GatewayId,
  name: "Katana test sandbox",
  rails: ["IMPS", "NEFT", "RTGS", "UPI"],
  // Every banker may use it, and only ever in test mode.
  creds: async () => ({ env: "TEST" }),
  providerRefFor: (txnRef) => txnRef,
  txnRefFrom: (ref) => ref,

  async transfer(_c, t) {
    const s = state(t.txnRef, t.amountMinor, 0);
    return { ok: true, data: { providerRef: s.providerRef, state: s.final ? s : undefined } };
  },

  async status(_c, ref) {
    const o = (await rows<{ amount_minor: string; secs: number | null }>("fifo", `
      SELECT amount_minor::text, EXTRACT(EPOCH FROM (now() - submitted_at))::int AS secs
        FROM fifo_orders WHERE txn_ref = $1 AND direction = 'PAYOUT' AND provider = $2
    `, [ref, SANDBOX_PAYOUT]).catch(() => []))[0];
    if (!o) return { ok: true, data: { found: false } };
    return { ok: true, data: state(ref, BigInt(o.amount_minor), o.secs ?? 0) };
  },
};
