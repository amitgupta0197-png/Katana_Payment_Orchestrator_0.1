// PayU Verify Payment API — ask PayU directly what happened to a transaction.
//
// WHY THIS EXISTS. Both ways PayU tells us about a payment can fail to arrive:
//
//   surl/furl  the customer's browser must come back. With UPI (Intent or Collect) the
//              customer approves inside their UPI app and very often never returns to
//              the browser at all, so this fires for only some payments.
//   webhook    a network blip, a misconfigured dashboard URL or a non-2xx reply and the
//              event is simply lost.
//
// Neither is authoritative. The Verify API is: we ask PayU, authenticated with our own
// key+salt, and PayU answers with the truth. This is what turns "probably paid" into
// "confirmed paid", and it is the only safe basis for releasing goods or settling money.
//
// Contract (PayU docs):
//   POST  https://info.payu.in/merchant/postservice.php?form=2      (PROD)
//         https://test.payu.in/merchant/postservice.php?form=2      (TEST)
//   body  key, command=verify_payment, var1=<txnid|txnid|...>, hash
//   hash  sha512(key|command|var1|salt)
//   reply { status: 0|1, msg, transaction_details: { <txnid>: { mihpayid, status,
//           bank_ref_num, amt, mode, error_code, error_Message } } }
//   A transaction PayU has never seen comes back with status "Not Found".

import { createHash } from "crypto";
import type { GatewayMid } from "@/lib/gateway-creds";

export interface PayuVerifyResult {
  /** true when PayU answered (status=1) and returned details for this txnid. */
  found: boolean;
  /** PayU's own status string, lower-cased: success | failure | pending | not found | ... */
  status: string;
  mihpayid?: string;
  bankRefNum?: string;
  amount?: string;
  mode?: string;
  error?: string;
  /** PayU's transaction_details entry, verbatim — fields we do not map are still useful. */
  raw?: Record<string, unknown>;
}

function verifyUrl(env?: "TEST" | "PROD"): string {
  return env === "PROD"
    ? "https://info.payu.in/merchant/postservice.php?form=2"
    : "https://test.payu.in/merchant/postservice.php?form=2";
}

/**
 * Ask PayU for the current state of one transaction.
 *
 * Never throws — a verify failure must not break the caller's sweep. An unreachable PayU
 * returns found=false, which callers must treat as "still unknown", NOT as failed. Marking
 * an order FAILED because our own network hiccuped would be worse than leaving it pending.
 */
export async function verifyPayuTxn(mid: GatewayMid, txnid: string): Promise<PayuVerifyResult> {
  const command = "verify_payment";
  const hash = createHash("sha512")
    .update([mid.key, command, txnid, mid.salt].join("|"))
    .digest("hex");

  const body = new URLSearchParams({ key: mid.key, command, var1: txnid, hash });

  try {
    const res = await fetch(verifyUrl(mid.env), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { found: false, status: "http_" + res.status };

    const text = await res.text();
    let j: any;
    try { j = JSON.parse(text); } catch { return { found: false, status: "unparseable" }; }
    if (j?.status !== 1 && j?.status !== "1") return { found: false, status: String(j?.msg ?? "verify_failed") };

    const d = j?.transaction_details?.[txnid];
    if (!d) return { found: false, status: "no_details" };

    const status = String(d.status ?? "").toLowerCase();
    // PayU answers "Not Found" for a txnid it has never seen — that is a definite answer
    // (we never actually reached PayU with this payment), not a transport failure.
    if (status === "not found") return { found: true, status: "not found" };

    return {
      found: true,
      status,
      mihpayid: d.mihpayid ? String(d.mihpayid) : undefined,
      bankRefNum: d.bank_ref_num ? String(d.bank_ref_num) : undefined,
      amount: d.amt != null ? String(d.amt) : undefined,
      mode: d.mode ? String(d.mode) : undefined,
      error: d.error_Message || d.error_code || undefined,
      raw: d as Record<string, unknown>,
    };
  } catch (e) {
    return { found: false, status: "unreachable" };
  }
}
