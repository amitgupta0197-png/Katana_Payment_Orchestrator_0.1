// CCAvenue pay-ins (hosted checkout only — CCAvenue has no server-to-server UPI intent).
//
// Contract (CCAvenue integration kit):
//   crypto    AES-128-CBC, key = md5(Working Key), iv = bytes 0x00..0x0f, hex output
//   hosted    browser POSTs encRequest + access_code to
//             {test|secure}.ccavenue.com/transaction/transaction.do?command=initiateTransaction
//             encRequest = encrypt("merchant_id=…&order_id=…&currency=…&amount=…&redirect_url=…&cancel_url=…&…")
//   return    CCAvenue POSTs encResp (+ orderNo) to redirect_url; decrypted it is a query string
//             with order_id, order_status, tracking_id, bank_ref_no, amount
//   status    POST {apitest|api}.ccavenue.com/apis/servlet/DoWebTrans
//             form: enc_request = encrypt(JSON {order_no}), access_code, command=orderStatusTracker,
//                   request_type=JSON, response_type=JSON, version=1.2
//             -> "status=0&enc_response=…"  decrypted: { order_status, order_amt, order_bank_ref_no, reference_no, … }
//
// Credentials: Merchant ID = mid.mid_code, Access Code = mid.key, Working Key = mid.salt.

import { createCipheriv, createDecipheriv, createHash } from "crypto";
import { paiseFrom, rupees, type PayinCall, type PayinConnector, type PayinState } from "@/lib/payin-providers/types";

const IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const keyOf = (workingKey: string) => createHash("md5").update(workingKey).digest();

export function ccavEncrypt(plain: string, workingKey: string): string {
  const c = createCipheriv("aes-128-cbc", keyOf(workingKey), IV);
  return c.update(plain, "utf8", "hex") + c.final("hex");
}

export function ccavDecrypt(hex: string, workingKey: string): string | null {
  try {
    const d = createDecipheriv("aes-128-cbc", keyOf(workingKey), IV);
    return d.update(hex.trim(), "hex", "utf8") + d.final("utf8");
  } catch {
    return null;
  }
}

const txHost = (env?: string) => (env === "PROD" ? "https://secure.ccavenue.com" : "https://test.ccavenue.com");
const apiHost = (env?: string) => (env === "PROD" ? "https://api.ccavenue.com" : "https://apitest.ccavenue.com");
const REF_OK = /^[A-Za-z0-9_-]{1,30}$/;

const SUCCESS = new Set(["SUCCESSFUL", "SUCCESS", "SHIPPED"]);
const FAILED = new Set(["UNSUCCESSFUL", "FAILURE", "ABORTED", "AUTO-CANCELLED", "CANCELLED", "INVALID", "FRAUD", "TIMEOUT"]);

export const ccavenuePayin: PayinConnector = {
  id: "CCAVENUE",
  name: "CCAvenue",

  async checkout(mid, o) {
    if (!REF_OK.test(o.txnid)) return { ok: false, error: "CCAvenue needs a txnid of at most 30 letters, digits, _ or -" };
    const plain = new URLSearchParams({
      merchant_id: mid.mid_code,
      order_id: o.txnid,
      currency: o.currency,
      amount: rupees(o.amountMinor),
      redirect_url: o.returnUrl,
      cancel_url: o.returnUrl,
      language: "EN",
      billing_name: o.firstname,
      billing_email: o.email,
      billing_tel: o.phone,
      merchant_param1: o.productinfo.slice(0, 100),
    }).toString();
    return {
      ok: true,
      data: {
        kind: "form",
        url: `${txHost(mid.env)}/transaction/transaction.do?command=initiateTransaction`,
        fields: { encRequest: ccavEncrypt(plain, mid.salt), access_code: mid.key },
      },
    };
  },

  async status(mid, txnid) {
    if (!REF_OK.test(txnid)) return { ok: true, data: { found: false } };
    let text: string;
    try {
      const res = await fetch(`${apiHost(mid.env)}/apis/servlet/DoWebTrans`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          enc_request: ccavEncrypt(JSON.stringify({ order_no: txnid }), mid.salt),
          access_code: mid.key, command: "orderStatusTracker",
          request_type: "JSON", response_type: "JSON", version: "1.2",
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      text = await res.text();
      if (!res.ok) return { ok: false, error: `CCAvenue lookup failed (HTTP ${res.status})` };
    } catch {
      return { ok: false, error: "CCAvenue unreachable" };
    }
    const outer = new URLSearchParams(text.trim());
    const enc = outer.get("enc_response") ?? "";
    // status=1: CCAvenue refused the call itself; enc_response then holds a plain message.
    if (outer.get("status") !== "0") return { ok: false, error: `CCAvenue lookup failed: ${enc.slice(0, 160) || text.slice(0, 160)}` };
    const plain = ccavDecrypt(enc, mid.salt);
    if (!plain) return { ok: false, error: "CCAvenue lookup failed: reply could not be decrypted (check the Working Key)" };
    let j: any;
    try { j = JSON.parse(plain); } catch { return { ok: false, error: "CCAvenue lookup failed: unreadable reply" }; }
    const d = j?.Order_Status_Result ?? j;
    if (String(d?.status) === "1") {
      const why = String(d?.error_desc ?? "");
      if (/no record|not found|invalid order/i.test(why)) return { ok: true, data: { found: false } };
      return { ok: false, error: `CCAvenue lookup failed: ${why.slice(0, 160)}` };
    }
    if (d?.order_no && String(d.order_no) !== txnid) return { ok: false, error: `CCAvenue answered for ${d.order_no}` };
    const st = String(d?.order_status ?? "").toUpperCase();
    const final: PayinState["final"] = SUCCESS.has(st) ? "SUCCESS" : FAILED.has(st) ? "FAILED" : null;
    return {
      ok: true,
      data: {
        found: true, final, status: st,
        paymentId: d?.reference_no ? String(d.reference_no) : undefined,
        bankRef: d?.order_bank_ref_no ? String(d.order_bank_ref_no) : undefined,
        amountMinor: paiseFrom(d?.order_amt),
        mode: d?.order_option_type ? String(d.order_option_type) : undefined,
        error: final === "FAILED" ? String(d?.order_fraud_status ?? d?.order_status ?? st) : undefined,
        raw: d,
      },
    };
  },
};
