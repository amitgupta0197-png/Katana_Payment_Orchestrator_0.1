// PayAtom pay-ins: UPI on PayAtom's "Payin P2P Seamless" product (India, API V2), on the
// merchant's own PayAtom account. In Katana it is an Intent gateway: PayAtom hands out the UPI
// string, the customer pays the UPI ID in it, and PayAtom confirms the payment.
//
// Contract (PayAtom docs → API Integrations → V2 → India → Payin P2P Seamless Integration, and
// V2 → Signature Generation):
//   auth      header X-Api-Key, and Katana's server IP whitelisted by PayAtom for the PID
//   signature SHA-256 hex of (the body without `signature`, keys sorted A-Z, compact JSON with "/"
//             escaped as "\/", as PHP's json_encode writes it) + secret key
//   request   POST {base}/api/v2/request.php {pid, amount (whole rupees), order_id, ip, name, email,
//             phone, latitude, longitude, customer_id, [upi_id when the merchant sent customer_vpa],
//             [redirect_url: Katana's /api/gateway/payatom/return, Intent (P2C) accounts], signature}
//             -> {status: "success", ref_code, qr_code: "upi://pay?pa=…", redirect_url, amount,
//                receiverVPA} | {status: "error", message} — always HTTP 200
//   status    POST {base}/api/v2/status_polling.php {pid, ref_code, post_hash}; no signature.
//             post_hash = base64(encrypt(md5(ref_code + pid + secret), secret))
//             -> {order_id, ref_code, upi_id, requested_amount, received_amount, bank_ref,
//                sender_upi, webhook_acknowledged, status, post_hash}
//   callback  POST JSON {order_id, requested_amount, received_amount, bank_ref, ref_code, status,
//             post_hash} to the callback URL PayAtom set at onboarding (not per order). Trusted
//             only when decrypt(post_hash) == md5(order_id + received_amount + status + secret).
//             PayAtom retries until it gets HTTP 200 with {"acknowledge": "yes"}.
//   encrypt   AES-256-CBC, key = sha256(secret), random 16-byte IV;
//             blob = iv (16) + HMAC-SHA256(key, ciphertext + iv) (32) + ciphertext
//   statuses  Pending, Approved, Late Approved, Amount Mismatch, User Timed Out, Declined,
//             Cancelled, Failed. received_amount is what to act on.
//
// Status polling needs PayAtom's ref_code, not Katana's order id: it is kept as the order's
// gateway payment id and passed to status() as `paymentRef`.
// Credentials: PID = mid.key, Secret key = mid.salt, extra.api_key (X-Api-Key), extra.api_base,
// extra.latitude / extra.longitude (PayAtom requires a location on every request).
// The UTR-submit API (customer-reported UTR) is not used yet.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { GatewayMid } from "@/lib/gateway-creds";
import { intentQueryOf, type PayinCall, type PayinConnector, type PayinState } from "@/lib/payin-providers/types";

/** The body PayAtom's server signs: sorted keys, compact JSON, "/" and non-ASCII escaped like PHP. */
export function payatomCanonical(params: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(params).filter((k) => k !== "signature").sort()) sorted[k] = params[k];
  return JSON.stringify(sorted)
    .replace(/\//g, "\\/")
    .replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

export function payatomSign(params: Record<string, unknown>, secret: string): string {
  return createHash("sha256").update(payatomCanonical(params) + secret).digest("hex");
}

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

/** PayAtom's encrypt(): iv + HMAC-SHA256(ciphertext + iv) + AES-256-CBC ciphertext. */
export function payatomEncrypt(plaintext: string, secret: string, iv: Buffer = randomBytes(16)): Buffer {
  const key = createHash("sha256").update(secret, "utf8").digest();
  const c = createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const mac = createHmac("sha256", key).update(Buffer.concat([ciphertext, iv])).digest();
  return Buffer.concat([iv, mac, ciphertext]);
}

/** PayAtom's decrypt(): the plaintext, or null when the HMAC or the padding is wrong. */
export function payatomDecrypt(blob: Buffer, secret: string): string | null {
  if (blob.length < 48 + 16) return null;
  const iv = blob.subarray(0, 16), mac = blob.subarray(16, 48), ciphertext = blob.subarray(48);
  const key = createHash("sha256").update(secret, "utf8").digest();
  const want = createHmac("sha256", key).update(Buffer.concat([ciphertext, iv])).digest();
  if (!timingSafeEqual(want, mac)) return null;
  try {
    const d = createDecipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([d.update(ciphertext), d.final()]).toString("utf8");
  } catch { return null; }
}

/** post_hash for a status poll. */
export function payatomPollHash(refCode: string, pid: string, secret: string, iv?: Buffer): string {
  return payatomEncrypt(md5(refCode + pid + secret), secret, iv).toString("base64");
}

/** As PayAtom prints an amount in the hash: "100", "12.5" (never "100.00"). */
const amountText = (v: unknown) => {
  const s = String(v ?? "");
  const n = Number(s);
  return s !== "" && Number.isFinite(n) ? String(n) : s;
};

/**
 * Whether a callback or a status answer is PayAtom's own: decrypt(post_hash) must equal
 * md5(order_id + received_amount + status + secret). True / false, or null when it has no hash.
 */
export function payatomBodyOk(body: Record<string, unknown>, secret: string): boolean | null {
  const ph = typeof body?.post_hash === "string" ? body.post_hash.trim() : "";
  if (!ph) return null;
  let blob: Buffer;
  try { blob = Buffer.from(ph, "base64"); } catch { return false; }
  const remote = payatomDecrypt(blob, secret);
  if (!remote) return false;
  const candidates = new Set([String(body.received_amount ?? ""), amountText(body.received_amount)]);
  return [...candidates].some((amt) => {
    const local = Buffer.from(md5(String(body.order_id ?? "") + amt + String(body.status ?? "") + secret));
    const r = Buffer.from(remote);
    return r.length === local.length && timingSafeEqual(r, local);
  });
}

function baseOf(mid: GatewayMid): string {
  return (mid.extra?.api_base ?? "").trim().replace(/\/$/, "");
}

async function post(mid: GatewayMid, path: string, body: unknown, timeoutMs = 15_000): Promise<PayinCall<{ httpStatus: number; body: any }>> {
  const base = baseOf(mid);
  if (!base) return { ok: false, error: "no PayAtom API base URL is saved for this account" };
  if (!mid.extra?.api_key) return { ok: false, error: "no PayAtom API key is saved for this account" };
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Api-Key": mid.extra.api_key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try { return { ok: true, data: { httpStatus: res.status, body: JSON.parse(text) } }; }
    catch { return { ok: false, error: `PayAtom returned a non-JSON reply (HTTP ${res.status})` }; }
  } catch {
    return { ok: false, error: "PayAtom unreachable" };
  }
}

/**
 * The UPI string of a created payment. Usually qr_code; on a "quasi intent" MID PayAtom leaves
 * qr_code empty and sends app links instead (additional_data.paytm_intent / phonepe_intent, seen
 * live 2026-10-05), so the UPI query is read from the first one that carries pa and am. Only the
 * UPI fields are kept (pa, pn, tr, am, cu, tn, mc): tn is PayAtom's note that matches the payment.
 */
export function payatomIntentQuery(body: any): string | null {
  const direct = intentQueryOf(body?.qr_code);
  if (direct) return direct;
  const extra = body?.additional_data;
  if (!extra || typeof extra !== "object") return null;
  const links = Object.entries(extra as Record<string, unknown>)
    .filter(([k, v]) => /intent/i.test(k) && typeof v === "string")
    .sort(([a], [b]) => Number(b.startsWith("upi")) - Number(a.startsWith("upi")))
    .map(([, v]) => v as string);
  for (const link of links) {
    const i = link.indexOf("?");
    if (i < 0) continue;
    const src = new URLSearchParams(link.slice(i + 1));
    if (!src.get("pa") || !src.get("am")) continue;
    const out = new URLSearchParams();
    for (const k of ["pa", "pn", "tr", "am", "cu", "tn", "mc"]) { const v = src.get(k); if (v) out.set(k, v); }
    if (!out.get("cu")) out.set("cu", "INR");
    return out.toString().replace(/\+/g, "%20");
  }
  return null;
}

const msgOf = (b: any, status: number) => String(b?.message || `HTTP ${status}`).slice(0, 200);

const SUCCESS = /^(approved|late approved)$/i;
// Paid, but not the amount asked for: reported as paid with what arrived, which Katana never
// applies by itself (lib/gateway-payin: "amount mismatch") — a person decides.
const MISMATCH = /^amount mismatch$/i;
const FAILED = /^(declined|cancell?ed|failed)$/i;
// "User Timed Out" can still become "Late Approved": left open, and Katana's own expiry and a
// later answer from PayAtom decide.

/** What a PayAtom transaction (callback or status answer) says, reduced to what Katana acts on. */
export function payatomPayinState(t: Record<string, any>): PayinState {
  const status = String(t?.status ?? "").trim();
  const received = Number(t?.received_amount);
  const paid = SUCCESS.test(status) || MISMATCH.test(status);
  const final: PayinState["final"] = paid ? "SUCCESS" : FAILED.test(status) ? "FAILED" : null;
  return {
    found: true, final,
    status: status || "UNKNOWN",
    paymentId: t?.ref_code ? String(t.ref_code) : undefined,
    bankRef: t?.bank_ref ? String(t.bank_ref) : undefined,
    amountMinor: paid && Number.isFinite(received) ? BigInt(Math.round(received * 100)) : undefined,
    mode: "UPI",
    error: final === "FAILED" ? status : undefined,
    raw: t,
  };
}

export const payatomPayin: PayinConnector = {
  id: "PAYATOM",
  name: "PayAtom",

  // Seamless only: Katana's own pay page shows PayAtom's UPI string. The request's redirect_url,
  // when PayAtom sends one, is used for a hosted checkout.
  async checkout(mid, o, client) {
    const r = await payatomPayin.upiIntent!(mid, o, client);
    if (!r.ok) return r;
    const url = r.data.redirectUrl;
    if (url && /^https:\/\//i.test(url)) return { ok: true, data: { kind: "redirect", url } };
    return { ok: false, error: "PayAtom gave no payment page for this order; use the UPI intent" };
  },

  async upiIntent(mid, o, client) {
    if (o.amountMinor % 100n !== 0n) return { ok: false, error: "PayAtom takes whole rupees only" };
    const lat = mid.extra?.latitude?.trim(), lng = mid.extra?.longitude?.trim();
    if (!lat || !lng) return { ok: false, error: "no location (latitude / longitude) is saved for this PayAtom account" };
    const params: Record<string, unknown> = {
      pid: mid.key,
      amount: Number(o.amountMinor / 100n),
      order_id: o.txnid,
      ip: client.ip || "127.0.0.1",
      name: o.firstname || "Customer",
      email: o.email,
      phone: o.phone,
      latitude: lat,
      longitude: lng,
      customer_id: o.phone || o.txnid,
    };
    // The customer's UPI ID: PayAtom's docs mark it required ("for intent flow"). Sent when the
    // merchant passed customer_vpa; Katana does not know it otherwise.
    const vpa = o.customerVpa?.trim();
    if (vpa && /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,64}$/.test(vpa)) params.upi_id = vpa;
    // Payin P2C Seamless (money lands with PayAtom) needs a redirect_url unless PayAtom set one at
    // registration: the customer comes back to Katana, which checks the order and shows the result.
    if (mid.extra?.channel !== "P2P" && o.returnUrl) params.redirect_url = o.returnUrl;
    params.signature = payatomSign(params, mid.salt);
    const r = await post(mid, "/api/v2/request.php", params, 20_000);
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    const q = payatomIntentQuery(body);
    if (body?.status !== "success")
      return { ok: false, error: `PayAtom did not create the payment: ${msgOf(body, httpStatus)}` };
    if (!q) return { ok: false, error: "PayAtom created the payment but sent no UPI link Katana can use" };
    return {
      ok: true,
      data: {
        intentQuery: q,
        paymentId: body.ref_code ? String(body.ref_code) : null,
        redirectUrl: typeof body.redirect_url === "string" ? body.redirect_url : null,
      },
    };
  },

  async status(mid, txnid, _amountMinor, paymentRef) {
    if (!paymentRef) return { ok: false, error: "PayAtom's reference (ref_code) for this order is not known" };
    const r = await post(mid, "/api/v2/status_polling.php", {
      pid: mid.key, ref_code: paymentRef, post_hash: payatomPollHash(paymentRef, mid.key, mid.salt),
    });
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    if (body?.status === "error" || httpStatus >= 400) {
      if (/not found/i.test(String(body?.message ?? ""))) return { ok: true, data: { found: false } };
      return { ok: false, error: `PayAtom lookup failed: ${msgOf(body, httpStatus)}` };
    }
    // An answer is believed only when it carries PayAtom's hash for this order.
    if (payatomBodyOk(body, mid.salt) !== true) return { ok: false, error: "PayAtom's status answer failed its hash check" };
    if (String(body.order_id ?? "") !== txnid) return { ok: false, error: `PayAtom answered for ${body.order_id}` };
    return { ok: true, data: payatomPayinState(body) };
  },
};
