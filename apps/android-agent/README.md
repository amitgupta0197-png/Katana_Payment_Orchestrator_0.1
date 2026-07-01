# Katana Transaction Agent (Android)

MTIP **Module 1 — Android Mobile Agent**. Reads incoming bank **UPI-credit alerts**
from **both bank SMS and bank/UPI-app notifications**, parses amount / UTR / payer VPA
/ bank, de-duplicates across the two sources, and forwards each credit to the
orchestrator's ingestion endpoint — with an **offline retry queue** so nothing is lost.

**Reliability stack (for maximum capture):**
- **SMS + notifications** — banks always SMS a credit; the SMS receiver fires even
  when the app process is dead.
- **Offline retry queue** — failed uploads persist and retry on the next event, app
  open, or the periodic worker.
- **Periodic worker (WorkManager)** — heartbeat + queue flush every 15 min, survives
  reboots (re-armed by the boot receiver).
- **Battery-optimization exemption** — keeps the OS from killing the agent.
- **OTP/PIN/password messages are never forwarded.**

> Because it reads SMS, **Google Play Protect** will show a one-time warning on a
> sideloaded build — tap **More details → Install anyway** (or **Install without
> scanning**). This is expected for any SMS-reading sideloaded app.

```
POST {baseUrl}/api/v1/txn-alert     (header: x-sandbox: 1)
{ source, device_id, bank, direction:"CREDIT", amount, utr, payer_vpa, raw }
```

The orchestrator's reconciler matches the credit to a PENDING PoolPay pay-in
(by UTR, then amount + payee VPA + recency) and auto-confirms the order — which is
what flips the customer pay page from the QR to **"Payment received"**.

> Auth is **sandbox mode** (`x-sandbox: 1`, no signing) for now, per request. HMAC
> signing can be switched on later (the server already supports `x-signature`).

## Build

Requires **Android Studio** (Hedgehog or newer) and **JDK 17**. This environment
can't produce an APK, so you build it:

1. In Android Studio: **Open** → select `apps/android-agent` → let Gradle sync
   (this generates the Gradle wrapper jar automatically).
2. Plug in the test phone (USB debugging on) and press **Run**, _or_
   **Build → Build Bundle(s)/APK(s) → Build APK(s)** and install the APK from
   `app/build/outputs/apk/debug/app-debug.apk`.

CLI alternative (needs a local Gradle ≥ 8.7 the first time):

```bash
cd apps/android-agent
gradle wrapper            # one-time, creates ./gradlew
./gradlew assembleDebug   # APK at app/build/outputs/apk/debug/app-debug.apk
```

## Set up on the phone

1. Install and open **Katana Agent**.
2. **Orchestrator base URL** — default `https://glhouse.shop` (leave as-is).
3. **Device ID** — any label (e.g. `pixel-7`). Tap **Save settings**.
4. Tap **Grant SMS permission** → Allow.
5. Tap **Enable notification access** → toggle **Katana Agent** on.
6. Tap **Allow background (battery)** → set to Unrestricted (stops the OS killing it).
7. Keep **Agent enabled** on, then **Save settings**. The status panel should show
   SMS granted, notification access enabled, battery unrestricted.
8. Tap **Send test credit alert** — a line appears under *Recent alerts* with the
   server outcome (`UNMATCHED` for the ₹1 test unless a pending order matches).

## Device trust (important)

Per the security architecture, only **TRUSTED** devices auto-confirm orders. The
default device id `android-agent-01` is seeded as TRUSTED, so it works out of the box.
If you change the device id, the first alert lands as a **manual case** and the device
shows up under **Transaction Intel → Devices** as `UNKNOWN` — tap **Trust** there, and
subsequent alerts auto-confirm. Unknown/suspended devices, OTP messages, duplicates,
fake senders, and low-confidence matches are routed to Operations / Risk, not
auto-confirmed.

## End-to-end demo

1. In the dashboard, create a PoolPay S2S order for some amount with a **real**
   receiver UPI ID in the pool.
2. From a UPI app, pay that amount to the receiver.
3. The bank's credit **SMS/notification** arrives → the agent forwards it (with a
   nonce for replay defence) → the orchestrator runs the forensic pipeline and, for a
   trusted device + confident match, confirms the order.
4. The `/pay/<id>` page QR closes and shows **Payment received**. Anything uncertain
   appears in **Transaction Intel** (manual cases / security alerts).

## Notes & limits (this slice)

- Captures **both** SMS and notifications; the same credit seen on both is forwarded
  once (3-minute de-dup window).
- Match window on the server is **30 minutes**; matching uses amount + payee VPA +
  recency (UTR exact when present).
- HTTPS only (`usesCleartextTraffic=false`). Point base URL at an HTTPS host.
- **Not** a Play-Store build — sideload it. SMS/notification parsing is heuristic
  across bank formats (HDFC/SBI/ICICI/Axis/Kotak/PNB/…); add patterns in
  `TxnParser.kt` if your bank's wording differs.
- Offline retry queue and device registration/heartbeat (BRD Module 1 extras) are
  **not** in this slice — failed posts are logged, not retried. Can be added next.
