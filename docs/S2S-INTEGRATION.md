# Katana — S2S Pay-in Integration Guide

How to create UPI pay-in (collect) orders programmatically from your own server and
receive the result. This is the production path behind the dashboard's "Create S2S
order" button.

---

## Concepts

- **Auth is per-merchant.** Every S2S call is authenticated with a **Checkout Key + Salt**
  pair that belongs to one merchant. There is no provider-level credential — a provider
  integrating into their own platform uses each merchant's Key + Salt (one pair per
  merchant) and passes the right `key` per order.
- **The Salt is secret** — keep it server-side only. The Key (`mk_…`) is a public handle.
- **Idempotent** on your `txnid`: re-sending the same `txnid` returns the same order.

### Getting a merchant's Key + Salt
Open the merchant in the dashboard → **Checkout integration (Key + Salt)** card →
**Generate**. The Salt is shown **once**. Available to:
- **Super Admin** — on the merchant detail page.
- **Provider** — on the provider portal's merchant detail page (mapped merchants only).

Pick a signing scheme when generating: `PAYU_SHA512` (default) or `HMAC_SHA256`.

---

## 1. Sign the order (server-side)

**HMAC_SHA256**
```
canonical = `${txnid}|${amount}|${productinfo}|${email}`
hash      = HMAC_SHA256(key + salt, canonical)        // lowercase hex
```

**PAYU_SHA512**
```
seq  = key|txnid|amount|productinfo|firstname|email|||||||||||salt
hash = sha512(seq)                                    // lowercase hex
```
(The `|||||||||||` are the empty udf1..udf5 + 5 reserved blanks, kept positional.)

`amount` is a major-unit string, e.g. `"10.00"`.

---

## 2. Create the pay-in

```
POST https://katanapay.co/api/v1/katana-pay/order
Content-Type: application/json
```

```jsonc
{
  "key":    "mk_xxx",
  "txnid":  "ORDER-1001",
  "amount": "10.00",
  "hash":   "<hex signature from step 1>",
  "productinfo": "Order 1001",     // optional, but must match what you signed
  "firstname":   "Asha",           // optional (used by PAYU_SHA512)
  "email":       "buyer@example.com", // optional, but must match what you signed
  "phone":       "9999999999",     // optional
  "mode":        "QR",             // "QR" or "INTENT"
  "customer_vpa":  "buyer@upi",    // optional payer VPA
  "receiver_vpas": ["pay@okicici"] // optional; defaults to the merchant's settlement VPA pool
}
```

Also accepts `application/x-www-form-urlencoded` (same fields).

> **Pre-filling amount, name & mobile.** Your platform sets `amount`, `firstname`
> (customer name) and `phone` (mobile) on every call — there's no manual typing. These
> are stored on the order, so the **same customer + amount appear on the Katana
> dashboard**, and on the result you receive (step 4), letting you reconcile that this
> customer paid this amount. The order only becomes **SUCCESS** when the money is
> actually received — that is your confirmation of receipt.

### Response (`201` new, `200` if reused)
```jsonc
{
  "verified": true,
  "merchant": "K-001",
  "reused": false,
  "order": { "id": "<uuid>", "order_id": "ORDER-1001", "amount": 10, "currency_code": "INR", "status": "PENDING" },
  "deeplinks": { "upi": "upi://pay?...", "paytm": "paytmmp://pay?...", "phonepe": "phonepe://pay?..." },
  "upi_intent": "upi://pay?pa=...&am=10.00...",
  "qr_payload": "upi://pay?pa=...&am=10.00...",
  "pay_url": "https://katanapay.co/pay/<uuid>"
}
```

### Errors
| Status | Meaning |
|--------|---------|
| `400`  | Bad request / invalid amount |
| `401`  | `invalid key` or `signature mismatch` |
| `403`  | Merchant is blocked |

---

## 3. Show the customer how to pay

Pick whichever fits your UX:
- **Redirect** the buyer's browser to `pay_url` (hosted page: QR + Paytm/PhonePe/GPay buttons, live status).
- **Render your own QR** from `qr_payload` / `upi_intent`.
- **Open an app** with `deeplinks.paytm` / `deeplinks.phonepe` / `deeplinks.upi` on mobile.

---

## 4. Get the result

### Option A — Webhook (recommended)
Set the merchant's **Webhook URL** (Profile → must be HTTPS). Katana `POST`s a signed JSON
event when the order's status changes.

Headers:
```
X-Event-Type:   payment.succeeded
X-Timestamp:    1719660000
X-Payload-Hash: <sha256 of the JSON body>
X-Signature:    HMAC-SHA256(webhook_secret, payloadHash + "." + timestamp)
X-Attempt:      1
```
To verify: reject if `X-Timestamp` is more than **±5 min** off; recompute the signature
and compare (timing-safe); return **2xx**. Retries: 1m → 5m → 15m → 1h → 6h → 24h, then
dead-letter. Make your handler **fast (< 5s)** and **idempotent**.

### Option B — Poll
```
GET https://katanapay.co/api/pay-status/<order.id>
→ { "order_id", "amount", "status", "terminal": true|false, "rrn": "<utr>" }
```
Poll until `terminal: true`. `status` becomes `SUCCESS` / `FAILED` / `EXPIRED`.

A pay-in is confirmed when the merchant's **trusted collection device** forwards the bank
credit SMS (auto-reconciliation), or when ops confirm it with a UTR.

---

## Minimal example (Node.js)

```js
import crypto from "crypto";

const BASE = "https://katanapay.co";
const KEY  = "mk_xxx";
const SALT = process.env.KATANA_SALT;          // secret — never ship to the client

const order = { txnid: "ORDER-1001", amount: "10.00", productinfo: "Order 1001", email: "buyer@example.com" };

// HMAC_SHA256 signature
const canonical = `${order.txnid}|${order.amount}|${order.productinfo}|${order.email}`;
const hash = crypto.createHmac("sha256", KEY + SALT).update(canonical).digest("hex");

const res = await fetch(`${BASE}/api/v1/katana-pay/order`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ key: KEY, ...order, hash, mode: "QR" }),
});
const data = await res.json();
if (!res.ok) throw new Error(data.error);

// Send the buyer to data.pay_url (or render data.qr_payload yourself),
// then confirm via webhook or by polling /api/pay-status/{data.order.id}.
```

---

## Sandbox testing

While Katana Pay runs in sandbox, the **last two paise digits of the amount** force outcomes:

| Amount ends in | Result |
|----------------|--------|
| `.99` (e.g. ₹9.99) | auto-SUCCESS (~8s) |
| `.11` | auto-EXPIRED |
| `.13` | auto-FAILED |
| anything else | stays PENDING until the SMS/webhook confirms; auto-expires after 15 min |

---

*Questions? Contact your Katana account manager.*
