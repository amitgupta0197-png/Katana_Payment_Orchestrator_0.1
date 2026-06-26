# PoolPay — Merchant Integration Guide

How a merchant's server creates a PoolPay UPI pay-in order on Katana and collects payment.

## Flow

```
Your server ──signed POST──► Katana /api/v1/poolpay/order
                                   │  returns deeplinks + pay_url
                                   ▼
        Redirect the customer to pay_url  (or render the QR / app buttons yourself)
                                   │  customer pays via UPI
                                   ▼
        Order is settled by  (a) the operations team confirming the UTR, or
                             (b) a bank/gateway webhook → /api/vendors/poolpay/callback
```

## 1. Credentials

Each merchant has a Katana **Checkout Key + Salt** (issued in the dashboard:
**Merchants → <merchant> → Checkout Key → Generate**). The salt is shown **once**.

- `key`  — public-ish identifier sent with every request (`mk_…`)
- `salt` — secret; never sent; used to sign each request
- `scheme` — `PAYU_SHA512` (default) or `HMAC_SHA256`

> Keep the salt server-side only. Never expose it in browser/JS.

## 2. Endpoint

```
POST https://glhouse.shop/api/v1/poolpay/order
Content-Type: application/json
```

### Request body

| field          | required | notes                                              |
|----------------|----------|----------------------------------------------------|
| `key`          | yes      | your checkout key (`mk_…`)                          |
| `txnid`        | yes      | your order id — **idempotency key** (≤ 60 chars)   |
| `amount`       | yes      | major units, string, e.g. `"100.00"`               |
| `hash`         | yes      | signature (see §3), lowercase hex                  |
| `productinfo`  | no       | order description                                  |
| `firstname`    | no       | customer name                                      |
| `email`        | no       | customer email                                     |
| `phone`        | no       | customer phone                                     |
| `customer_vpa` | no       | customer UPI VPA (for collect)                     |
| `currency`     | no       | defaults `INR`                                     |

`txnid` is idempotent: repeating a `txnid` returns the existing order (`"reused": true`) instead of creating a duplicate.

### Response `201` (new) / `200` (reused)

```json
{
  "verified": true,
  "merchant": "K-PROD_TEST",
  "reused": false,
  "order": {
    "id": "17d4207c-23ca-4c52-bd29-ce75d57933f9",
    "order_id": "ORD-1782466804610",
    "amount": "100.00",
    "currency_code": "INR",
    "status": "PENDING",
    "created_at": "2026-06-26T09:40:04.610Z"
  },
  "deeplinks": {
    "paytm":   "paytmmp://pay?pa=…",
    "phonepe": "phonepe://pay?pa=…",
    "upi":     "upi://pay?pa=…"
  },
  "upi_intent": "upi://pay?pa=…",
  "qr_payload": "upi://pay?pa=…",
  "pay_url": "https://glhouse.shop/pay/17d4207c-23ca-4c52-bd29-ce75d57933f9"
}
```

- **`pay_url`** — a hosted page with the QR + Paytm/PhonePe/UPI buttons and live status. Redirect the customer here (simplest), or build your own page from `deeplinks` / `qr_payload`.

### Errors

| status | body                              | meaning                          |
|--------|-----------------------------------|----------------------------------|
| 400    | `{"error":"…"}`                   | bad/missing fields, bad amount   |
| 401    | `{"error":"invalid key"}`         | unknown key / key mismatch       |
| 401    | `{"error":"signature mismatch"}`  | `hash` didn't verify             |

## 3. Signature

The string you sign must use the **exact** `amount` string you send (`"100.00"`, not `100`).

### PAYU_SHA512 (default)

```
seq  = key|txnid|amount|productinfo|firstname|email|||||||||||salt
       (between email and salt: 5 empty udf fields + 5 empty reserved fields = 10 empties)
hash = sha512(seq)  → lowercase hex
```

### HMAC_SHA256

```
message = txnid|amount|productinfo|email
hash    = HMAC_SHA256(key + salt, message)  → lowercase hex
```

Empty optional fields are the empty string `""` (the pipe separators stay).

## 4. Code examples

### Node.js

```js
import crypto from "node:crypto";

const KEY = process.env.POOLPAY_KEY;     // mk_…
const SALT = process.env.POOLPAY_SALT;   // secret
const o = { txnid: "ORD-" + Date.now(), amount: "100.00", productinfo: "Order", firstname: "Test", email: "a@b.com" };

// PAYU_SHA512
const seq = [KEY, o.txnid, o.amount, o.productinfo, o.firstname, o.email,
  "", "", "", "", "", "", "", "", "", "", SALT].join("|");
const hash = crypto.createHash("sha512").update(seq).digest("hex");

// HMAC_SHA256 (if your scheme is HMAC):
// const hash = crypto.createHmac("sha256", KEY + SALT)
//   .update([o.txnid, o.amount, o.productinfo, o.email].join("|")).digest("hex");

const res = await fetch("https://glhouse.shop/api/v1/poolpay/order", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: KEY, ...o, hash, currency: "INR" }),
});
console.log(res.status, await res.json());
```

### PHP

```php
<?php
$key  = getenv('POOLPAY_KEY');
$salt = getenv('POOLPAY_SALT');
$o = ['txnid' => 'ORD-' . time(), 'amount' => '100.00',
      'productinfo' => 'Order', 'firstname' => 'Test', 'email' => 'a@b.com'];

// PAYU_SHA512
$seq = implode('|', [$key, $o['txnid'], $o['amount'], $o['productinfo'], $o['firstname'], $o['email'],
  '', '', '', '', '', '', '', '', '', '', $salt]);
$hash = hash('sha512', $seq);

// HMAC_SHA256 alternative:
// $hash = hash_hmac('sha256', implode('|', [$o['txnid'],$o['amount'],$o['productinfo'],$o['email']]), $key.$salt);

$payload = array_merge(['key' => $key], $o, ['hash' => $hash, 'currency' => 'INR']);
$ch = curl_init('https://glhouse.shop/api/v1/poolpay/order');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
  CURLOPT_POSTFIELDS => json_encode($payload),
  CURLOPT_RETURNTRANSFER => true,
]);
echo curl_exec($ch);
```

### Python

```python
import os, time, hashlib, hmac, json, urllib.request

KEY  = os.environ["POOLPAY_KEY"]
SALT = os.environ["POOLPAY_SALT"]
o = {"txnid": f"ORD-{int(time.time())}", "amount": "100.00",
     "productinfo": "Order", "firstname": "Test", "email": "a@b.com"}

# PAYU_SHA512
seq = "|".join([KEY, o["txnid"], o["amount"], o["productinfo"], o["firstname"], o["email"],
                "", "", "", "", "", "", "", "", "", "", SALT])
h = hashlib.sha512(seq.encode()).hexdigest()

# HMAC_SHA256 alternative:
# msg = "|".join([o["txnid"], o["amount"], o["productinfo"], o["email"]])
# h = hmac.new((KEY + SALT).encode(), msg.encode(), hashlib.sha256).hexdigest()

payload = {"key": KEY, **o, "hash": h, "currency": "INR"}
req = urllib.request.Request("https://glhouse.shop/api/v1/poolpay/order",
    data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
print(urllib.request.urlopen(req).read().decode())
```

## 5. Getting the final status

The order starts `PENDING`. It becomes terminal (`SUCCESS` / `FAILED` / `EXPIRED`) when:

- **Operations** confirm the UTR/RRN in the cockpit (manual / scrape / screenshot), or
- a **bank/gateway webhook** posts to `POST /api/vendors/poolpay/callback` (HMAC-signed).

The hosted `pay_url` page reflects the live status automatically. To learn the status
server-to-server, poll the public endpoint:

```
GET https://glhouse.shop/api/pay-status/<order.id>
→ { status, terminal, rrn, deeplinks, upi_intent }
```

## 6. Sandbox behaviour

Until real PoolPay credentials are wired (`POOLPAY_MODE=live`), the deeplinks are valid
UPI-format strings and the status settles deterministically: amounts ending **.13** fail,
**.11** expire, anything else succeeds ~8s after the status page first polls — or whenever
operations confirm it.
