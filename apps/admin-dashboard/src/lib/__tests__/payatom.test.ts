// PayAtom's signing and hashes (lib/payin-providers/payatom), checked against the worked example in
// PayAtom's own docs and against its encrypt / decrypt format.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import {
  payatomBodyOk, payatomCanonical, payatomDecrypt, payatomEncrypt, payatomPayinState, payatomPollHash, payatomSign,
} from "@/lib/payin-providers/payatom";
import { merchantSafeError } from "@/lib/merchant-safe";

const SECRET = "your-secret-key";
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

// The guide's printed hash (280b18e3…) is not what its own PHP, Python or Node samples produce for
// that input; this is what they produce (checked with PHP's json_encode + hash on 2026-10-04).
test("signature: the example in PayAtom's Signature Generation guide, as its reference code signs it", () => {
  const params = {
    pid: "your-partner-id", amount: 100, redirect_url: "https://your-domain.com/return_page", ip: "your-server-ip",
    name: "Customer Name", email: "customer@email.com", phone: "9876543210", latitude: "28.7041", longitude: "77.1025",
    customer_id: "CUST001",
  };
  assert.equal(payatomCanonical(params),
    '{"amount":100,"customer_id":"CUST001","email":"customer@email.com","ip":"your-server-ip","latitude":"28.7041","longitude":"77.1025","name":"Customer Name","phone":"9876543210","pid":"your-partner-id","redirect_url":"https:\\/\\/your-domain.com\\/return_page"}');
  assert.equal(payatomSign(params, SECRET), "69f9285e926f4fb34b96e68b97f73ba0936dbd5b1d88a0d8ac51838fba328f54");
  // The signature field itself is never signed.
  assert.equal(payatomSign({ ...params, signature: "x" }, SECRET), payatomSign(params, SECRET));
});

test("canonical JSON escapes non-ASCII as PHP's json_encode does", () => {
  assert.equal(payatomCanonical({ name: "Rāj" }), '{"name":"R\\u0101j"}');
});

test("encrypt / decrypt round trip; a wrong key or a changed byte gives null", () => {
  const blob = payatomEncrypt("hello", SECRET);
  assert.equal(payatomDecrypt(blob, SECRET), "hello");
  assert.equal(payatomDecrypt(blob, "other"), null);
  const bad = Buffer.from(blob); bad[bad.length - 1] ^= 1;
  assert.equal(payatomDecrypt(bad, SECRET), null);
});

test("status poll post_hash decrypts to md5(ref_code + pid + secret)", () => {
  const ph = payatomPollHash("REF1", "PID9", SECRET);
  assert.equal(payatomDecrypt(Buffer.from(ph, "base64"), SECRET), md5("REF1PID9" + SECRET));
});

test("callback hash: only PayAtom's own, for this order, amount and status", () => {
  const body = (o: Record<string, unknown> = {}) => {
    const b: Record<string, unknown> = { order_id: "kp_1", requested_amount: "100", received_amount: "100", status: "Approved", bank_ref: "UTR1", ref_code: "R", ...o };
    b.post_hash = payatomEncrypt(md5(String(b.order_id) + String(b.received_amount) + String(b.status) + SECRET), SECRET).toString("base64");
    return b;
  };
  assert.equal(payatomBodyOk(body(), SECRET), true);
  assert.equal(payatomBodyOk(body(), "other-secret"), false);
  assert.equal(payatomBodyOk({ ...body(), status: "Declined" }, SECRET), false);      // changed after hashing
  assert.equal(payatomBodyOk({ ...body(), received_amount: "1000" }, SECRET), false);
  assert.equal(payatomBodyOk({ order_id: "kp_1", status: "Approved" }, SECRET), null); // no hash at all
  // A status answer's received_amount is a number: 100 hashes as "100".
  const b = body(); b.received_amount = 100;
  assert.equal(payatomBodyOk(b, SECRET), true);
});

test("statuses: Approved / Late Approved paid; Amount Mismatch paid with what arrived; timed out stays open", () => {
  const s = (status: string, received = "100") => payatomPayinState({ status, received_amount: received, ref_code: "R", bank_ref: "U" });
  assert.equal(s("Approved").final, "SUCCESS");
  assert.equal(s("Approved").amountMinor, 10000n);
  assert.equal(s("Late Approved").final, "SUCCESS");
  // Paid a different amount: reported with that amount, which Katana never applies by itself.
  assert.equal(s("Amount Mismatch", "90").final, "SUCCESS");
  assert.equal(s("Amount Mismatch", "90").amountMinor, 9000n);
  for (const f of ["Declined", "Cancelled", "Failed"]) assert.equal(s(f).final, "FAILED");
  for (const p of ["Pending", "User Timed Out", ""]) assert.equal(s(p).final, null);
  assert.equal(s("Approved").paymentId, "R");
  assert.equal(s("Approved").bankRef, "U");
});

test("a merchant never reads PayAtom's name", () => {
  const msg = merchantSafeError("PayAtom did not create the payment: Invalid pid", "test");
  assert.doesNotMatch(msg, /payatom/i);
});

// ── The connector's calls, against a stand-in for PayAtom's server ─────────────────────────────

import { payatomPayin } from "@/lib/payin-providers/payatom";
import type { GatewayMid } from "@/lib/gateway-creds";

const MID: GatewayMid = {
  gateway: "PAYATOM", mid_code: "", key: "PID9", salt: SECRET, scheme: "sha512" as GatewayMid["scheme"], env: "PROD",
  extra: { api_key: "AK", api_base: "https://pa.example/", latitude: "19.07", longitude: "72.87" },
};
const ORDER = {
  txnid: "kp_abc", amountMinor: 50000n, currency: "INR", productinfo: "x", firstname: "Customer",
  email: "payments@katanapay.co", phone: "9876543210", returnUrl: "", notifyUrl: "",
};

function stub(reply: (url: string, body: any, headers: Record<string, string>) => unknown) {
  const real = globalThis.fetch;
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const headers = init.headers as Record<string, string>;
    calls.push({ url, body, headers });
    return new Response(JSON.stringify(reply(url, body, headers)), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("upiIntent: signed request with the API key; PayAtom's UPI string and ref_code come back", async () => {
  const s = stub(() => ({ status: "success", ref_code: "REFX", qr_code: "upi://pay?pa=p2p@upi&pn=X&am=500&cu=INR&tr=kp_abc", amount: 500, receiverVPA: "p2p@upi" }));
  try {
    const r = await payatomPayin.upiIntent!(MID, ORDER, { ip: "1.2.3.4", deviceInfo: "" });
    assert.equal(r.ok, true);
    if (r.ok) { assert.equal(r.data.paymentId, "REFX"); assert.match(r.data.intentQuery, /^pa=p2p@upi&/); }
    const c = s.calls[0];
    assert.equal(c.url, "https://pa.example/api/v2/request.php");
    assert.equal(c.headers["X-Api-Key"], "AK");
    assert.equal(c.body.amount, 500);           // whole rupees
    assert.equal(c.body.order_id, "kp_abc");
    assert.equal(c.body.ip, "1.2.3.4");
    assert.equal(c.body.signature, payatomSign(c.body, SECRET));
  } finally { s.restore(); }
});

test("upiIntent: refused before any call for paise, or with no location saved", async () => {
  const s = stub(() => ({}));
  try {
    assert.equal((await payatomPayin.upiIntent!(MID, { ...ORDER, amountMinor: 50050n }, { ip: "", deviceInfo: "" })).ok, false);
    assert.equal((await payatomPayin.upiIntent!({ ...MID, extra: { ...MID.extra, latitude: "" } }, ORDER, { ip: "", deviceInfo: "" })).ok, false);
    assert.equal(s.calls.length, 0);
  } finally { s.restore(); }
});

test("upiIntent: PayAtom's error (always HTTP 200) is an error", async () => {
  const s = stub(() => ({ status: "error", message: "Invalid signature" }));
  try {
    const r = await payatomPayin.upiIntent!(MID, ORDER, { ip: "", deviceInfo: "" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Invalid signature/);
  } finally { s.restore(); }
});

test("status: polled by ref_code; believed only with PayAtom's hash for this order", async () => {
  const answer = (o: Record<string, unknown> = {}) => {
    const b: Record<string, unknown> = { order_id: "kp_abc", ref_code: "REFX", requested_amount: 500, received_amount: 500, bank_ref: "UTR9", status: "Approved", ...o };
    b.post_hash = payatomEncrypt(md5(String(b.order_id) + String(b.received_amount) + String(b.status) + SECRET), SECRET).toString("base64");
    return b;
  };
  let s = stub((_u, body) => {
    // The poll's own post_hash is PayAtom's format over ref_code + pid.
    assert.equal(payatomDecrypt(Buffer.from(body.post_hash, "base64"), SECRET), md5("REFX" + "PID9" + SECRET));
    return answer();
  });
  try {
    const r = await payatomPayin.status(MID, "kp_abc", 50000n, "REFX");
    assert.equal(r.ok, true);
    if (r.ok) { assert.equal(r.data.final, "SUCCESS"); assert.equal(r.data.amountMinor, 50000n); assert.equal(r.data.bankRef, "UTR9"); }
    assert.equal(s.calls[0].url, "https://pa.example/api/v2/status_polling.php");
  } finally { s.restore(); }

  s = stub(() => ({ ...answer(), status: "Approved", received_amount: 5000 }));   // tampered after hashing
  try { assert.equal((await payatomPayin.status(MID, "kp_abc", 50000n, "REFX")).ok, false); } finally { s.restore(); }

  s = stub(() => answer({ order_id: "kp_other" }));                                 // someone else's order
  try { assert.equal((await payatomPayin.status(MID, "kp_abc", 50000n, "REFX")).ok, false); } finally { s.restore(); }

  s = stub(() => ({ status: "error", message: "Reference code not found." }));
  try {
    const r = await payatomPayin.status(MID, "kp_abc", 50000n, "REFX");
    assert.equal(r.ok && r.data.found, false);
  } finally { s.restore(); }

  // Without PayAtom's ref_code there is nothing to ask with.
  assert.equal((await payatomPayin.status(MID, "kp_abc", 50000n, null)).ok, false);
});

// ── PayAtom on the P2P flow: the account says where the money lands ────────────────────────────

import { gatewayAccountChannel, gatewayDef, validateCredFields } from "@/lib/pg-catalog";
import { classifyPayinOrder } from "@/lib/payin-channel";

test("an account runs on P2P only when its gateway offers it and it was saved as P2P", () => {
  assert.equal(gatewayAccountChannel({ gateway: "PAYATOM", extra: { channel: "P2P" } }), "P2P");
  assert.equal(gatewayAccountChannel({ gateway: "PAYATOM", extra: { channel: "INTENT" } }), "INTENT");
  assert.equal(gatewayAccountChannel({ gateway: "PAYATOM" }), "INTENT");
  // A gateway without P2P is Intent whatever is stored.
  assert.equal(gatewayAccountChannel({ gateway: "RUBYVAULT", extra: { channel: "P2P" } }), "INTENT");
  assert.equal(gatewayAccountChannel(null), "INTENT");
});

test("a P2P processor order is P2P with the processor as its rail; others as before", () => {
  assert.deepEqual(classifyPayinOrder("PAYATOM", "P2P"), { type: "P2P", id: "PAYATOM" });
  assert.deepEqual(classifyPayinOrder("PAYATOM", "INTENT"), { type: "INTENT", id: "PAYATOM" });
  assert.deepEqual(classifyPayinOrder("RUBYVAULT"), { type: "INTENT", id: "RUBYVAULT" });
  assert.deepEqual(classifyPayinOrder(null), { type: "P2P", id: "UPI_DIRECT" });
});

test("PayAtom credentials: where the money lands must be chosen from the options", () => {
  const svc = gatewayDef("PAYATOM")!.payin;
  const base = { key: "PID", salt: "S", api_key: "K", api_base: "https://pa.example", latitude: "19.07", longitude: "72.87" };
  assert.match(validateCredFields(svc, base).error ?? "", /money lands/);
  assert.match(validateCredFields(svc, { ...base, channel: "BANK" }).error ?? "", /choose one/);
  assert.equal(validateCredFields(svc, { ...base, channel: "P2P" }).values?.channel, "P2P");
});

test("upiIntent: the customer's UPI ID goes as upi_id; a malformed one is left out", async () => {
  const s = stub(() => ({ status: "success", ref_code: "R", qr_code: "upi://pay?pa=x@upi&am=500", amount: 500 }));
  try {
    await payatomPayin.upiIntent!(MID, { ...ORDER, customerVpa: " buyer@okaxis " }, { ip: "", deviceInfo: "" });
    await payatomPayin.upiIntent!(MID, { ...ORDER, customerVpa: "not a vpa" }, { ip: "", deviceInfo: "" });
    await payatomPayin.upiIntent!(MID, ORDER, { ip: "", deviceInfo: "" });
    assert.equal(s.calls[0].body.upi_id, "buyer@okaxis");
    assert.equal("upi_id" in s.calls[1].body, false);
    assert.equal("upi_id" in s.calls[2].body, false);
    // Whatever is sent is signed.
    assert.equal(s.calls[0].body.signature, payatomSign(s.calls[0].body, SECRET));
  } finally { s.restore(); }
});

test("upiIntent: an Intent (P2C) account sends Katana's return URL as redirect_url; a P2P account does not", async () => {
  const s = stub(() => ({ status: "success", ref_code: "R", qr_code: "upi://pay?pa=x@upi&am=500", amount: 500 }));
  const back = "https://katanapay.co/api/gateway/payatom/return?txnid=kp_abc";
  try {
    await payatomPayin.upiIntent!({ ...MID, extra: { ...MID.extra, channel: "INTENT" } }, { ...ORDER, returnUrl: back }, { ip: "", deviceInfo: "" });
    await payatomPayin.upiIntent!({ ...MID, extra: { ...MID.extra, channel: "P2P" } }, { ...ORDER, returnUrl: back }, { ip: "", deviceInfo: "" });
    assert.equal(s.calls[0].body.redirect_url, back);
    assert.equal(s.calls[0].body.signature, payatomSign(s.calls[0].body, SECRET));
    assert.equal("redirect_url" in s.calls[1].body, false);
  } finally { s.restore(); }
});

test("quasi intent: an empty qr_code is read from PayAtom's app links (live reply, 2026-10-05)", async () => {
  const live = {
    ref_code: "9a07ced0", qr_code: "", status: "success", redirect_url: "https://p2flow.in/pay/pay_X", amount: 201,
    receiverVPA: "gpay-12202885821@okbizaxis",
    additional_data: {
      paytm_intent: "paytmmp://cash_wallet?pa=gpay-12202885821@okbizaxis&pn=P2Flow&tr=&am=201.00&cu=INR&tn=1vcep1&mc=7221&featuretype=money_transfer",
      phonepe_intent: "phonepe://native?data=eyJ9&id=p2ppayment",
    },
  };
  const s = stub(() => live);
  try {
    const r = await payatomPayin.upiIntent!(MID, { ...ORDER, amountMinor: 20100n }, { ip: "", deviceInfo: "" });
    assert.equal(r.ok, true);
    if (r.ok) {
      const q = new URLSearchParams(r.data.intentQuery);
      assert.deepEqual([q.get("pa"), q.get("pn"), q.get("am"), q.get("cu"), q.get("tn"), q.get("mc")],
        ["gpay-12202885821@okbizaxis", "P2Flow", "201.00", "INR", "1vcep1", "7221"]);
      assert.equal(q.get("tr"), null);                 // empty in PayAtom's link: left out
      assert.equal(q.get("featuretype"), null);        // Paytm's own field: left out
      assert.equal(r.data.paymentId, "9a07ced0");
    }
  } finally { s.restore(); }
});

test("success with no usable UPI link is an error that says so", async () => {
  const s = stub(() => ({ status: "success", ref_code: "R", qr_code: "", additional_data: {} }));
  try {
    const r = await payatomPayin.upiIntent!(MID, ORDER, { ip: "", deviceInfo: "" });
    assert.ok(!r.ok && /no UPI link/.test(r.error));
  } finally { s.restore(); }
});
