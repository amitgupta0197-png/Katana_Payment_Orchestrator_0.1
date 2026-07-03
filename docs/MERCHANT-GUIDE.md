# Katana — Merchant Portal Guide

A quick guide to using your Katana merchant portal. Your portal only ever shows **your** business's data.

> In-app version: this same guide is available inside the portal under **Help & guide**.

---

## Signing in

- Go to your portal's **/login** page.
- Sign in with the **email** and **password** your Katana account manager shared with you.
- Change your password anytime under **Profile → Change password** (enter your current password, then the new one).

---

## 1. Issue an API key

Use API keys to connect your own systems (server, checkout, back office) to Katana's APIs.

**Steps**
1. Go to **API keys** in the sidebar → click **Issue key**.
2. Enter a **label** (e.g. "Production server") and select the **scopes** the key needs.
3. Click issue. The **secret** (starts with `sk_`) is shown **once** — copy and store it securely. It is never shown again.
4. Send the key in the `Authorization` header of your API requests:

```
Authorization: Bearer sk_your_secret_key_here
```

**Scopes**

| Scope    | Grants |
|----------|--------|
| `payin`  | Accept payments |
| `payout` | Payouts & settlement |
| `refund` | Issue refunds |
| `status` | Query transaction status |

**Notes**
- Only a hash of the secret is stored — we can't recover it for you. If lost, issue a new key and update your integration.
- The list shows each key's prefix (first 10 chars), scopes, status, and last-used time.

---

## 2. Configure webhooks

Webhooks let Katana notify your system in real time when a payment's status changes.

**Steps**
1. Go to **Profile**.
2. Set your **Webhook URL** — it **must be HTTPS** (e.g. `https://api.yoursite.com/katana/webhook`). Optionally set a **Return URL** for post-payment redirects.
3. Click **Save**. Katana will `POST` a JSON event to that URL on each order update.
4. On your endpoint, **verify the signature** and respond `2xx`.

**Headers we send**

```
X-Event-Type:   payment.succeeded
X-Timestamp:    1719660000
X-Payload-Hash: <sha256 of the JSON body>
X-Signature:    <HMAC-SHA256(secret, payloadHash + "." + timestamp)>
X-Attempt:      1
```

**How to verify**
1. Reject if `X-Timestamp` is more than **±5 minutes** from now (replay protection).
2. Compute `HMAC-SHA256(your_secret, sha256(body) + "." + timestamp)` and compare to `X-Signature` using a timing-safe comparison.
3. Return HTTP `2xx` to acknowledge.

**Retries**
- If your endpoint doesn't return `2xx`, we retry on a backoff: **1m → 5m → 15m → 1h → 6h → 24h**.
- After 6 failed attempts the event goes to a dead-letter queue.
- Keep your handler **fast (< 5s)** and **idempotent** (the same event may arrive more than once).

---

## 3. Sub-MIDs

Sub-MIDs are the merchant IDs that route your live traffic.

- Open **Sub-MIDs** to view the ones assigned to you. Each shows its parent **Main MID**, **mode**, **KYC status**, and whether **settlement** is enabled.
- **Requesting a new Sub-MID is done by your provider / account manager — not self-service.** Contact them with your expected volume and use-case; the new Sub-MID appears here once created.

**Statuses & modes**
- Mode `TRAFFIC` = handling live traffic; `KYC_APPROVED` = KYC cleared.
- KYC status moves `PENDING → APPROVED`.
- Settlement is a separate switch your provider enables.

---

## 4. Settlement statements

Shows when your collected money is paid out to your bank.

- Open **Settlements** to see each settlement **batch**: date, number of transactions, gross, fees, and **net**.

```
Net payout = Gross collected − Fees − Reserves held
```

**Statuses**
- `PENDING` — batch created, payout not yet sent.
- `COMPLETED` — money transferred; the **UTR** (bank reference) and payout reference are filled in.

Use the **UTR** to reconcile the credit against your bank statement.

---

*Need more help? Contact your Katana account manager.*
