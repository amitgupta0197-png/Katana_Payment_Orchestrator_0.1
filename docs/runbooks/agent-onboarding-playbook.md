# Katana Payment Reconciliation — Operations Playbook

How to make the system **capture real UPI payments and auto-close the QR** — device
setup, enrolment, trust, the email fallback, testing, and troubleshooting.

- **Dashboard:** https://glhouse.shop
- **Agent APK:** https://glhouse.shop/katana-agent.apk  (current: v1.4 / versionCode 5)
- **Agent app:** "Katana Agent" (`shop.glhouse.agent`)

---

## 1. How it works (the model)

A customer pays a UPI QR/intent → the money lands in the merchant's **real** UPI
account (Paytm/PhonePe for Business, or a bank). Katana then **captures** that credit
and **matches** it to the pending order, which flips the pay page from the QR to
**"Payment received"** and closes it.

Capture happens through **three channels** — any one is enough:

| Channel | Where it runs | Best for | Carries UTR? |
|---|---|---|---|
| **Bank SMS** | Android agent on the phone | Bank-account credits | Usually yes |
| **App push notification** | Android agent on the phone | Paytm/PhonePe **Business** | No |
| **Email (IMAP)** | Server (no phone needed) | Business merchants whose push is unreliable | No |

Matching ladder (server): **UTR exact → amount + payee VPA + recency → amount +
recency**. A unique match within the last **30 minutes** from a **trusted** source
auto-confirms. Anything ambiguous/unmatched goes to a **manual reconciliation queue**
(Transaction Intel). Email is the most reliable for business merchants because it
always arrives.

> **Key rule:** the agent must be on the **same phone** that receives the payment
> notification, OR use the **email channel** (which needs no phone).

---

## 2. Prerequisites

- A merchant exists in the dashboard with a **merchant code** (e.g. `UK-108`).
- The phone that will run the agent is the **same phone** logged into the merchant's
  Paytm/PhonePe Business app (for the push/SMS channels).
- Admin access to the dashboard to **trust** devices.
- (Email channel) A Gmail inbox that receives the payment emails + a Gmail **App
  Password**.

---

## 3. Device setup — the phone (5 minutes)

1. **Install** the agent: open https://glhouse.shop/katana-agent.apk on the phone,
   download, install. Google Play Protect may warn on a sideloaded SMS app → tap
   **More details → Install anyway**.
2. Open **Katana Agent** and fill **Connection**:
   - **Orchestrator base URL:** `https://glhouse.shop` (leave as-is)
   - **Device ID:** leave the auto-generated unique id (e.g. `agent-9cdb2cc8`), or set
     a friendly **unique** name (e.g. `uk108-phone1`). **Never reuse one ID on two
     phones.**
   - **Merchant code:** the merchant's code (e.g. `UK-108`)
   - **Forward alerts:** ON
   - Tap **Save settings** (the merchant code is verified ✓ against the server).
3. Grant permissions (the status panel shows ✓ as each is granted):
   - **Grant SMS permission** → Allow
   - **Enable notification access** → toggle **Katana Agent** ON  *(required for
     Paytm/PhonePe Business pushes)*
   - **Allow background (battery)** → set to **Unrestricted**  *(stops the OS killing
     the listener — the #1 cause of missed pushes)*
4. Tap **Send test alert** → a line appears under **Recent activity** with the server
   outcome (`UNMATCHED` for the ₹1 test is normal — no order matches it).

If the test line shows **"✓ → UNMATCHED"**, the phone is connected. If it shows
**"queued — failed to connect"**, see **Troubleshooting → Agent can't connect**.

---

## 4. Admin — trust the device (required)

A new device registers as **UNKNOWN** and **cannot auto-confirm** until trusted (this
is by security design). Two ways:

- **From the merchant page:** open the merchant → **Transaction agent & permissions**
  card → click **Trust** on the device row. *(or)*
- **Transaction Intel → Devices** → find the device → **Trust**.

A device is **ready** only when all four are green: **TRUSTED · Notification access ·
Forwarding · Online**. Until then the card shows **"incomplete / Action needed"** —
the missing item is almost always **Trust**.

> The seeded IDs `android-agent-01` and `sim-device-01` are pre-trusted (for demos).
> Real phones must be trusted explicitly.

---

## 5. Email channel — the reliable fallback (recommended for business merchants)

Use this when the Paytm/PhonePe push is unreliable, or to run **without** a phone at
all. The server reads the merchant's inbox and confirms from the payment email.

1. On the Google account that receives the payment emails:
   - Enable **2-Step Verification** (Google Account → Security).
   - Create an **App Password** (Security → App passwords → name it "Katana") → 16 chars.
   - Enable **IMAP** (Gmail → Settings ⚙ → Forwarding and POP/IMAP → Enable IMAP).
2. On the server, set in `/opt/katana/apps/admin-dashboard/.env.local`:
   ```
   EMAIL_INGEST_ENABLED=1
   EMAIL_INGEST_USER=receiver@gmail.com
   EMAIL_INGEST_PASSWORD=<16-char app password>
   EMAIL_INGEST_MERCHANT=UK-108
   ```
   then `systemctl restart katana`.
3. A cron polls every minute. Verify:
   ```
   curl -s -X POST -H "x-cron-key: <FIFO_CRON_KEY>" http://127.0.0.1:3100/api/v1/cron/email-poll
   ```
   → `{"enabled":true,"scanned":N,"ingested":M,...}`.

Notes: processed emails are marked **read** (so they aren't re-processed). Use a
dedicated mailbox where possible. One mailbox → one merchant for now.

---

## 6. End-to-end test

1. In the dashboard, create a **PoolPay S2S order** with a **real** receiver UPI ID
   (the merchant's Business VPA).
2. From a UPI app, **pay that amount** to the QR.
3. Within seconds (push/SMS) or ~1 minute (email), the credit is captured → the order
   auto-confirms → the **pay page shows "Payment received"** and the QR closes.
4. If it stays PENDING, check the capture: agent **Recent activity** should show a
   `[NOTIFICATION]`/`[SMS]` line; or the email poll should report `ingested`.

> **Tip — avoid amounts ending in `.13 / .11 / .99` paise** unless
> `POOLPAY_SANDBOX_OUTCOMES` is intentionally off in prod (it is). Those were old
> sandbox test triggers and are now disabled, but keep amounts clean.

---

## 7. Multiple devices / multiple merchants

- The backend supports **many devices per merchant** and many merchants. Each device
  is tracked independently (online, trust, permissions).
- Give every phone a **unique Device ID**. v1.4 auto-generates one per install.
- **Trust each** device once (Section 4).
- See the live list under **Transaction Intel → Devices** or the merchant's agent card.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| **QR never closes after a real payment** | Credit not captured | Confirm the agent is on the **same phone** as the Paytm app, **or** enable the **email channel** (§5). Check agent Recent activity for a capture line. |
| **"queued — failed to connect" on the phone** | The phone's **network** can't reach the server (carrier/WiFi block) | Try **mobile data** (or switch WiFi off/on), toggle **airplane mode**, disable VPN/Private DNS. The server is fine if it loads in the phone's browser. |
| **Device shows "incomplete / Action needed"** | Device not **TRUSTED** | Click **Trust** on the device (§4). |
| **Order went to "Payment failed" with no payment** | (legacy) sandbox amount rule | Already fixed — sandbox outcomes are disabled in prod. Keep amounts not ending in .13/.11/.99. |
| **Customer paid an expired order** | Order timed out (15 min) before payment | A real credit now **auto-revives** an expired order to SUCCESS. Money is never stranded. |
| **Push not captured but email arrived** | Paytm didn't post a push / listener asleep | Use the **email channel** (§5) — it always arrives. Also: re-toggle Notification access, set battery Unrestricted, update to v1.4. |
| **Two phones fighting / duplicate** | Same Device ID on both | Give each a **unique** Device ID (§3) and re-trust. |

Manual fallback: any uncaptured/ambiguous credit lands in **Transaction Intel →
Manual cases** — an operator can **Confirm** the order there by hand.

---

## 9. Deploy & operate (admin)

- **App lives at:** `/opt/katana/apps/admin-dashboard` on `root@72.61.227.233`,
  served by systemd unit **`katana.service`**, behind nginx at **glhouse.shop**.
- **Deploy:** rsync source (exclude `node_modules`, `.next`, `.env.local`) → `pnpm
  install` → `pnpm run build` → `systemctl restart katana`.
- **Rebuild the agent APK:** in `apps/android-agent`, `./gradlew assembleRelease`
  (JDK 17 + Android SDK), bump `versionCode`/`versionName`, copy
  `app/build/outputs/apk/release/app-release.apk` → `apps/admin-dashboard/public/
  katana-agent.apk`, redeploy. Same signing key → installs as an update.
- **Crons (every-minute / daily):** `crontab -l` — `status-sweep`, `email-poll`,
  `daily`, authenticated by `x-cron-key` (`FIFO_CRON_KEY`).
- **DB:** `vendorgatewayservice_db` — `vendor_payin_orders` (orders),
  `vendor_txn_alerts` (captured credits), `vendor_devices` (forwarders),
  `vendor_manual_cases`, `vendor_security_alerts`.

---

## 10. Going-live checklist

- [ ] Each merchant's phone has the agent, **trusted**, notification access + battery
      unrestricted, correct merchant code.
- [ ] Email channel configured for business merchants (recommended).
- [ ] A real test payment auto-closes the QR end-to-end.
- [ ] Amounts are clean (whole rupees recommended).
- [ ] Expiry window (15 min) acceptable; late payments auto-revive.
- [ ] (When connecting the real PoolPay gateway) set `POOLPAY_MODE=live` +
      credentials and complete the `TODO(poolpay)` API mapping in `lib/poolpay.ts`.
      Until then the gateway is a self-reconciled sandbox (real money, own capture).

---

*Last updated: 2026-06-30 · Agent v1.4 · See also: docs/ and the Transaction Intel console.*
