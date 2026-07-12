# Katana Pay — Integration Guide

Hosted-checkout pay-ins for any platform. Base URL: `https://katanapay.co` · v1

> Shareable HTML version (printable to PDF, no login): `https://katanapay.co/katana-pay-integration.html`

**Flow:** your server creates a **signed order** → you redirect the customer to our **hosted payment page** → the customer pays by UPI → we **POST a signed status callback** to your server *and* redirect the customer back to your `return_url`. You verify every signature with the **Key + Salt** we issue you.

---

## 1. Credentials (Key + Salt)

Issued from the Katana dashboard (**Branch portal → Integration → Generate Key + Salt**, or ask your Katana admin).

| Field | Meaning |
|---|---|
| `Key` | Public-ish identifier (`mk_…`) sent with every request. |
| `Salt` | **Secret.** Shown once at issue. Signs requests + verifies callbacks. Server-side only. |
| `Scheme` | `HMAC_SHA256` (recommended) or `PAYU_SHA512`. |

> Keep the Salt safe. Lost it → regenerate, which **invalidates the old pair**. One active Key per account.

## 2. Endpoints

| Purpose | Method | URL |
|---|---|---|
| Create order (S2S) | **POST** | `https://katanapay.co/api/v1/katana-pay/order` |
| Hosted payment page | GET | `https://katanapay.co/pay/{order_id}` |
| Status enquiry | GET | `https://katanapay.co/api/pay-status/{order_id}` |

> **Production:** your server's outbound IP must be **IP-whitelisted** by Katana first.

## 3. Create an order

`POST /api/v1/katana-pay/order` with JSON. Idempotent on `txnid`.

| Field | Req | Description |
|---|---|---|
| `key` | yes | Your Key. |
| `txnid` | yes | Your unique order ref (≤60). |
| `amount` | yes | Rupees, e.g. `"100"` / `"100.50"`. |
| `hash` | yes | Signature (see §4). |
| `productinfo` | no | Order description (signed). |
| `firstname` | no | Customer name (PAYU signature). |
| `email` | no | Customer email (signed). |
| `phone` | no | Customer phone. |
| `return_url` | no | Browser redirect after payment. |
| `notify_url` | no | S2S status-callback target. |
| `currency` | no | Default `INR`. |
| `mode` | no | `QR` or `INTENT`. |

**Response (201 new / 200 reused):**
```json
{ "verified": true, "merchant": "UK-108",
  "order": { "id": "8d20c0b6-…", "order_id": "ORDER-1001", "status": "PENDING" },
  "pay_url": "https://katanapay.co/pay/8d20c0b6-…",
  "deeplinks": { "upi": "upi://pay?…" }, "upi_intent": "upi://pay?…", "qr_payload": "upi://pay?…" }
```
Errors: `401 invalid key`, `401 signature mismatch`, `403` (blocked), `400 invalid amount`.

## 4. Sign the request

**HMAC_SHA256 (recommended):**
```
message = txnid + "|" + amount + "|" + productinfo + "|" + email
hash    = HMAC_SHA256(key = KEY + SALT, message)        // lowercase hex
```
**PAYU_SHA512:**
```
seq  = KEY|txnid|amount|productinfo|firstname|email|||||||||||SALT   // 5 udf + 5 reserved blanks
hash = SHA512(seq)                                       // lowercase hex
```

## 5. Redirect to the payment page

Send the browser to `pay_url`. After payment it redirects back to your `return_url`:
```
https://your-site.com/return?order_id=ORDER-1001&status=SUCCESS&rrn=123456789012
```
> Always re-confirm server-side (callback or enquiry) before fulfilling.

## 6. Receive the status callback

On every terminal status we **POST** JSON to your `notify_url` (or saved webhook URL). Reply **HTTP 200**; we retry until you do.
```json
{ "PAY_ID":"…", "ORDER_ID":"ORDER-1001", "TXN_ID":"…", "AMOUNT":"100", "CURRENCY_CODE":"356",
  "STATUS":"Captured", "RESPONSE_CODE":"000", "RRN":"123456789012",
  "RESPONSE_DATE_TIME":"2026-07-01T…Z", "HASH":"716346F5…EC21" }
```
**Verify HASH with your Salt:**
1. Take every field **except** `HASH`.
2. Sort keys **ascending**; join as `KEY=value` with `~` between pairs.
3. Append your `SALT` to the end.
4. `SHA256` → hex → **UPPERCASE**; must equal `HASH`.

**Paid** = `STATUS=Captured` and `RESPONSE_CODE=000`.

## 7. Status enquiry

`GET /api/pay-status/{order_id}` → `{ status, amount, rrn, terminal, … }`. Use as a fallback if a callback is missed.

## 8. Status & response codes

| STATUS | RESPONSE_CODE | Meaning |
|---|---|---|
| Captured | 000 | Paid — fulfil. |
| Pending | 005 | Awaiting payment. |
| Failed | 004 | Declined / failed. |
| Expired | 003 | Request lapsed. |

## 9. Sample code

**Node.js — create order**
```js
import crypto from "crypto";
const key="mk_xxx", salt="your_salt";
const o={ txnid:"ORDER-1001", amount:"100", productinfo:"Order 1001", email:"d@e.com" };
o.hash=crypto.createHmac("sha256",key+salt).update([o.txnid,o.amount,o.productinfo,o.email].join("|")).digest("hex");
const r=await fetch("https://katanapay.co/api/v1/katana-pay/order",{method:"POST",
  headers:{"Content-Type":"application/json"},
  body:JSON.stringify({...o,key,return_url:"https://you.com/return",notify_url:"https://you.com/callback"})});
const data=await r.json();   // redirect customer to data.pay_url
```
**PHP — create order**
```php
$key="mk_xxx"; $salt="your_salt";
$o=["txnid"=>"ORDER-1001","amount"=>"100","productinfo"=>"Order 1001","email"=>"d@e.com"];
$o["hash"]=hash_hmac("sha256",$o["txnid"]."|".$o["amount"]."|".$o["productinfo"]."|".$o["email"],$key.$salt);
$o["key"]=$key; $o["return_url"]="https://you.com/return"; $o["notify_url"]="https://you.com/callback";
$ch=curl_init("https://katanapay.co/api/v1/katana-pay/order");
curl_setopt_array($ch,[CURLOPT_POST=>1,CURLOPT_RETURNTRANSFER=>1,
  CURLOPT_HTTPHEADER=>["Content-Type: application/json"],CURLOPT_POSTFIELDS=>json_encode($o)]);
$res=json_decode(curl_exec($ch),true);
header("Location: ".$res["pay_url"]);
```
**Python — create order**
```python
import hmac,hashlib,requests
key,salt="mk_xxx","your_salt"
o={"txnid":"ORDER-1001","amount":"100","productinfo":"Order 1001","email":"d@e.com"}
o["hash"]=hmac.new((key+salt).encode(),"|".join([o["txnid"],o["amount"],o["productinfo"],o["email"]]).encode(),hashlib.sha256).hexdigest()
o.update(key=key, return_url="https://you.com/return", notify_url="https://you.com/callback")
data=requests.post("https://katanapay.co/api/v1/katana-pay/order",json=o).json()
# redirect customer to data["pay_url"]
```
**Verify a callback (Node.js)**
```js
function verify(body, salt){
  const got=body.HASH; const f={...body}; delete f.HASH;
  const str=Object.keys(f).sort().map(k=>`${k}=${f[k]==null?"":f[k]}`).join("~")+salt;
  return crypto.createHash("sha256").update(str,"utf8").digest("hex").toUpperCase()===got;
}
```

## 10. Go-live checklist

- Generate your **Key + Salt**; store the Salt server-side only.
- Set default **return_url** + **webhook URL** in the dashboard (or pass per order).
- Send your server's **public IP** to Katana for whitelisting.
- Test a small amount; confirm the callback arrives and the **HASH verifies**.
- Treat callbacks as **idempotent** (same `ORDER_ID` may repeat).
- Always confirm **server-side** before fulfilling.
