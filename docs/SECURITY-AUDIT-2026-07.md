# Katana Security Audit — July 2026

**Classification: CONFIDENTIAL.** Contains live exploit detail against the production deployment. Do not share outside the core team.

**Scope:** `apps/admin-dashboard` (the internet-facing Next.js BFF + all four portals) and the `apps/android-agent` client side. Four independent adversarial code reviews (auth/access-control, crypto/secrets, SQL/input-validation, payment/device-trust boundary), cross-checked against the deployed `.env.local`.

**Bottom line:** The access-control *design* is sound — persona gating and per-row scoping are enforced consistently, and there is no SQL injection or IDOR in the routes reviewed. **The exploitable risk is concentrated in two places: (1) the production environment is running on committed dev-default / unset secrets, and (2) the device-ingestion endpoints fail *open* — they can be driven unauthenticated to forge payment confirmations.** Several of these are the exact rotations flagged as "still outstanding" after the July VPS compromise. Treat the Criticals as **active incidents**.

---

## Remediation status (branch `security/hardening-2026-07`, typechecked)

| Finding | Status | Notes |
|---|---|---|
| C2 (x-sandbox) | ✅ code done | New `device-auth.ts`. **Callback routes** close in prod now. **Device routes** need `LEGACY_SANDBOX_AGENTS=1` until the agent is updated to sign — see the ⚠️ below. |
| C3 (body `source` trust) | ✅ code done | Trust now requires internal `channelTrusted`; public body can't self-assert EMAIL/BANK_API. |
| C5 (demo login) | ✅ code done | Demo fallback disabled in production. |
| H1 (amount check) | ✅ code done | order_ref / UTR paths refuse amount mismatches. |
| H5 (email hijack) | ✅ code done | ON CONFLICT no longer re-points an existing inbox's merchant. |
| H7 (set-password) | ✅ code done | Refuses to target privileged staff accounts. |
| H9 (SSRF) | ✅ code done | New `safe-fetch.ts` wired into all three webhook sinks. |
| M1 (timing compare) | ✅ code done | Device routes use `timingSafeEqual`. |
| C1/C4/H2/H3/H8 (fail-closed secrets) | ✅ code done — **deploy after rotation** | `secrets.ts` + `reseal-vault.mjs`. The app now refuses to boot on a missing/default secret, so secrets must be rotated **first**. |
| C1/C4/H3/H8 (rotate the live values) | ⏳ needs you | Rotate on the server; only you can. |
| H4 (text-alert/agent-debug) | ✅ code done | Both now require a device signature. |
| H6 (capture-rrn merchant binding) | ✅ code done | Poll bound to the device's enrolled merchant. |
| M2 (timestamp in signature) | ✅ code done | Signature is over `${timestamp}.${payload}` on both server and agent. |
| Agent signing (unblocks C2 device routes) | ✅ code done — needs APK build+deploy | Agent v2.37 signs with `AGENT_SIGNING_SECRET`; `x-sandbox` removed. Server verifies via `verifyDeviceRequest`. |
| M3–M7, L1–L5 | ⏳ todo | Phase 2 structural hardening. |

> ✅ **Agent signing implemented.** The deployed agent used to authenticate with the `x-sandbox: 1` header (no real auth). The agent (v2.37) now signs every request with a dedicated `AGENT_SIGNING_SECRET` (HMAC-SHA256, timestamp bound in), and the server verifies it. Rollout: **(1)** set `AGENT_SIGNING_SECRET` on the server (same value baked into the APK via `keystore.properties → agentSigningSecret`); **(2)** deploy the server with `LEGACY_SANDBOX_AGENTS=1` so current devices keep working; **(3)** build + distribute the new APK; **(4)** once the fleet is updated, remove `LEGACY_SANDBOX_AGENTS` — the device-route bypass is then fully closed. The unauthenticated *callback* path (the worst C2 vector) is already closed regardless.

## Severity summary

| # | Severity | Finding | One-request exploit? |
|---|----------|---------|:---:|
| C1 | 🔴 Critical | Production `SESSION_SECRET` is the public dev default → forge any session, incl. SUPER_ADMIN | Yes |
| C2 | 🔴 Critical | `x-sandbox: 1` header disables all device/callback auth, not env-gated → mint paid orders | Yes |
| C3 | 🔴 Critical | Body-declared `source:"EMAIL"/"BANK_API"` grants trusted-channel status with no device | Yes |
| C4 | 🔴 Critical | `VAULT_MASTER_KEY` unset → whole credential vault encrypted under a public constant | — |
| C5 | 🔴 Critical | `DEMO_PASSWORD=demo` live → any un-migrated account logs in with "demo" | Yes |
| H1 | 🟠 High | No amount check on the order_ref/UTR confirm path → ₹1 alert clears a ₹50k order | Yes |
| H2 | 🟠 High | `FIFO_WEBHOOK_SECRET` falls back to the dev default → signed device routes forgeable | Yes |
| H3 | 🟠 High | `PG_PASSWORD` committed in repo and reused live | — |
| H4 | 🟠 High | `text-alert` and `agent-debug` have zero authentication | Yes |
| H5 | 🟠 High | `device/email-config` inbox hijack → point any merchant's ingest at attacker mailbox | Yes |
| H6 | 🟠 High | `capture-rrn` cross-merchant disclosure + request-state tampering via query param | Yes |
| H7 | 🟠 High | `admin/set-password` can target SUPER_ADMIN → ADMIN escalates to SUPER_ADMIN | Yes |
| H8 | 🟠 High | Vendor webhook secret defaults to public `sandbox-secret-do-not-use-in-prod` | Yes |
| H9 | 🟠 High | SSRF via tenant-controlled webhook/callback URLs, with a response/error oracle back to the caller | Yes |
| M1 | 🟡 Med | Device-route HMAC compared with `!==` (not constant-time) | — |
| M8 | 🟡 Med | Open redirect via merchant-supplied `return_url` on the hosted `/pay` page | — |
| M2 | 🟡 Med | Timestamp not bound into signature → ±5min replay window is defeated; capture-rrn has no replay check | — |
| M3 | 🟡 Med | Device binding is recorded at login but never enforced → stolen cookie is portable for 8h | — |
| M4 | 🟡 Med | No rate-limit / lockout on `/api/auth/login` | — |
| M5 | 🟡 Med | Merchant status callback sent **unsigned** (`HASH:""`) when creds are missing | — |
| M6 | 🟡 Med | Sessions are stateless and cannot be revoked before their 8h expiry | — |
| M7 | 🟡 Med | MFA is default-off; `checkLoginCode` returns true when a user hasn't enrolled | — |
| L1–L5 | ⚪ Low | TOTP compare non-constant-time; `COOKIE_SECURE` opt-out; no CSRF tokens; enrich-merge NULL-VPA merge; PoolPay plain-hash MAC (safe but non-standard) | — |

---

## The Criticals, in detail

### C1 — Production session secret is the public default → full takeover
**Files:** `src/lib/auth.ts:27`, `src/middleware.ts:20`. Confirmed in the deployed `.env.local`: `SESSION_SECRET=dev-session-secret-do-not-use-in-prod` — the exact string shipped in `.env.example`.

The session cookie is `base64url(payload).HMAC-SHA256(payload, SESSION_SECRET)`. Because the key is public, an attacker computes their own valid cookie:

1. Build payload `{user_id,email,persona:"SUPER_ADMIN",scope_id:null,exp:<now+8h>}`, base64url it.
2. `sig = HMAC_SHA256("dev-session-secret-do-not-use-in-prod", payload)`.
3. Send `Cookie: katana_session=payload.sig`. Both `verifySession` (app) and the edge middleware accept it. Attacker is SUPER_ADMIN — or any provider/merchant/banker by changing `scope_id`.

**Fix:** rotate to a 32-byte random secret **and** make the app refuse to boot on a missing/default value (see code plan). Rotation invalidates all live cookies.

### C2 — `x-sandbox: 1` disables all device/callback auth, in production
**Files:** `src/app/api/v1/txn-alert/route.ts:45`, `vendors/poolpay/callback/route.ts:37`, `vendors/[vendor]/callback/route.ts:45`, `capture-rrn`, `device/heartbeat`, `device/email-config`. All are `PUBLIC_API` in `middleware.ts`. The pattern is `const sandbox = header==="1"; if (!sandbox) {…verify…}` — with **no `NODE_ENV` gate anywhere** (grep-confirmed).

Most direct exploit — no secret, no device:
```
POST /api/vendors/poolpay/callback
x-sandbox: 1
{"order_id":"<KP order id>","status":"SUCCESS","utr":"123456789012","settlement_status":"SETTLED"}
```
`confirmPoolPayOrder` flips the order to SUCCESS/SETTLED and fires the merchant "paid" callback. The `order_id` is printed on the pay page and embedded as `tr=` in the UPI deeplink, so it's not secret. **Money released with no payment.**

**Fix:** gate the bypass behind `process.env.ALLOW_SANDBOX_AUTH==="1" && NODE_ENV!=="production"`, or remove header auth-skip entirely and give the tester a real signed path. Apply to all six routes.

### C3 — Client-chosen `source` bypasses the device-trust model
**File:** `src/lib/txn-reconcile.ts:377` — `const trusted = deviceStatus==="TRUSTED" || source==="EMAIL" || source==="BANK_API";`. `source` comes verbatim from the request body. The whole "confirmation requires a trusted device" architecture collapses: any caller sets `source:"BANK_API"` and is trusted with no device. `isFakeSender` also early-returns false for these sources, disabling that guard too. A **REVOKED** device just sets `source:"EMAIL"` and its status is never consulted.

**Fix:** trust must derive from the authenticated channel, never a body field. `EMAIL` reachable only from the internal server-side poller; `BANK_API` only from a signed gateway credential. On the public route, force `source` through the device-trust ladder.

### C4 — Credential vault runs on a hardcoded public key
**File:** `src/lib/credential-vault.ts:19` — `masterKey()` falls back to `Buffer.alloc(32, 0x42)` when `VAULT_MASTER_KEY` is unset, and it is **absent from `.env.example` and the deployed `.env.local`**. Every sealed secret (gateway MID key+salt, PoolPay `SECRET_KEY`/API key, merchant checkout salts, bank creds) is AES-256-GCM encrypted under 32 bytes of `0x42` — a value published in the source. Anyone with a DB dump or the repo decrypts the entire vault. This is effectively **plaintext-at-rest for all payment credentials**. (The GCM construction itself is correct — fresh IV, auth tag verified; the only defect is the key source.)

**Fix:** refuse to boot without `VAULT_MASTER_KEY` in production; generate a real key; **re-seal every vault row** under the new key (old rows become undecryptable, so this must be a migration, not a swap).

### C5 — `DEMO_PASSWORD=demo` active in production
**File:** `src/app/api/auth/login/route.ts:35`, `src/lib/password.ts:19`. Live `.env.local` has `DEMO_PASSWORD=demo`. Any account whose `password_hash` is null or not scrypt-prefixed is accepted with the password `demo`. MFA is default-off, so it doesn't backstop this. Any seeded/un-migrated account — including admin seeds — is loggable with `demo`.

**Fix:** remove the demo path in production (`if (!isRealHash(hash)) return 401`); audit the `users` table for null/non-scrypt hashes now; force resets.

---

## High findings (condensed)

- **H1 — No amount validation on confirm.** `txn-reconcile.ts:313-327`: the `order_ref` and UTR match paths set confidence 100 **without comparing alert amount to order amount**, and `confirmPoolPayOrder` never checks it. A ₹1 forged alert confirms a ₹50,000 order, defeating `HIGH_AMOUNT_HOLD`. **Fix:** require `alert.amount === order.amount` on these paths and inside `confirmPoolPayOrder`.
- **H2 — Device HMAC secret defaults to the dev value.** `fifo-notify.ts:9`: `FIFO_WEBHOOK_SECRET ?? SESSION_SECRET ?? "dev-webhook-secret"`; live env leaves it unset → resolves to the known default. A second, independent forge path for the device routes, and the *same* key signs outbound merchant callbacks (trust-boundary violation). **Fix:** dedicated strong secret, fail-closed, separate inbound-vs-outbound keys.
- **H3 — Committed DB password.** `pg.ts:12` + `.env.example` + live: `sixsenai_pg_2024_secure`. **Fix:** rotate, remove fallback, placeholder in example.
- **H4 — `text-alert` & `agent-debug` have no auth.** `text-alert` feeds attacker `merchant_id`/`amount`/`utr` into `ingestTxnAlert` (queue poisoning, RRN mis-attribution via enrich-merge); `agent-debug` is an unauthenticated large-row insert (storage DoS). **Fix:** same HMAC-over-body auth as the fixed `txn-alert`.
- **H5 — Email-config inbox hijack.** `device/email-config`: sandbox-bypassable, `merchant_id` unvalidated, `ON CONFLICT (email) DO UPDATE SET merchant_id=…` lets an attacker re-point any merchant's ingest to their own mailbox (then plant "payment received" emails, trusted via C3). **Fix:** session-scoped binding; never accept body `merchant_id`; don't reassign on conflict.
- **H6 — `capture-rrn` cross-merchant leak.** `merchant_id` is a query param unbound to the caller; any device polls `?merchant_id=<victim>` to read that merchant's open requests (amount, payer_vpa, alert_id) and flip their state PENDING→SENT (DoS of real capture). **Fix:** bind to the authenticated device's own merchant.
- **H7 — `set-password` privilege escalation.** `admin/set-password` (gated ADMIN+SUPER_ADMIN) resets **any** account by email with no "cannot target higher privilege" guard → an ADMIN resets a SUPER_ADMIN's password and takes over. **Fix:** forbid targeting SUPER_ADMIN/ADMIN (and self-escalation).
- **H8 — Vendor webhook secret default.** `webhooks.ts:72`: `?? "sandbox-secret-do-not-use-in-prod"` → forge vendor callbacks when unset. **Fix:** fail closed; source from vault.
- **H9 — SSRF via tenant-controlled webhook URLs.** `webhook-outbox.ts:104`, `fifo-notify.ts:38`, `settlement-notify.ts:41`, `merchant-callback.ts:54` all `fetch()` a merchant/provider-supplied URL (`notify_url` / `callback_url` / channel `target`), validated only by `z.string().url()` — **no private-IP / loopback / cloud-metadata (169.254.169.254) block**. Worse, the outbox **stores the response body** (readable in the admin webhook view) and `fifo-notify` writes the HTTP status/error into the merchant-readable order timeline → a read-SSRF + internal-port-scan oracle. A merchant sets `notify_url=http://169.254.169.254/latest/meta-data/…` or an internal host and reads results back. **Fix:** a single `safeFetch()` that resolves the host and rejects RFC-1918/loopback/link-local/ULA/`.internal` and non-http(s) schemes, pins the resolved IP (anti DNS-rebind), and caps/strips the stored response body.

---

## What is already safe (verified, no action)

- **SQL injection:** parameterized throughout via `pg.ts` (call sites traced, not just grepped). Dynamic SQL only interpolates `$n` markers, static allow-listed column names, or Zod-stripped body keys — never user *values*. No dynamic table/column/ORDER BY from request input. No injection found.
- **Money handling:** `money.ts` stores bigint minor units; `toMinor` regex-rejects scientific notation/NaN; every consumer guards `<= 0n`, so negative-amount strings are caught downstream. Not exploitable.
- **File uploads:** magic-byte scan, size caps, MIME allowlist, server-generated storage filenames (user filename never used in a path), UUID-cast before `path.join`, and a `path.resolve().startsWith(STORE)` containment check on read. No path traversal.
- **Persona gate + row scoping:** every sampled route calls `gateOrResponse([...])` and derives identity from the signed session, not the body; `scopeFor` defaults unknown personas to `FALSE`. No IDOR found.
- **`POOLPAY_SANDBOX_OUTCOMES`** (amount-suffix fake outcomes) is env-gated, OFF by default, and **cannot** be flipped by request input.
- **Proof upload is parking-only** (`PROOF_SUBMITTED`), does not settle; hardened type/size/magic-byte checks, out-of-root storage.
- **Duplicate-UTR block & final-status lock** in `confirmPoolPayOrder` are correct (one RRN → one order; terminal states immutable).
- **Device trust cannot be self-promoted** (setting TRUSTED requires SUPER_ADMIN/ADMIN/RISK). The weakness is C3 making TRUSTED irrelevant, not self-promotion.
- **Telegram webhook** checks both the secret-token header and the admin chat allowlist.
- **Crypto primitives** (GCM vault, scrypt passwords, checkout signature `timingSafeEqual`) are correctly built; the defects are key *sourcing*, not the algorithms.

---

## Remediation plan (sequenced — order matters)

### Phase 0 — Emergency, today (server-side; you execute)
Because several code fixes **fail the app closed on a missing/default secret**, secrets must be rotated *before* those fixes deploy, or the app won't boot. Sequence:

1. **Generate + set real secrets** in the deployed `.env.local` (32-byte random for each): `SESSION_SECRET`, `VAULT_MASTER_KEY`, `FIFO_WEBHOOK_SECRET`, and a distinct vendor secret. Rotate `PG_PASSWORD` (sync Postgres + env), `POOLPAY_SECRET` (with PoolPay), and any Google secret. Remove `DEMO_PASSWORD` (or set a strong dev-only value).
   - `SESSION_SECRET` rotation logs everyone out (expected).
   - `VAULT_MASTER_KEY` needs a **re-seal migration** of existing vault rows, not a bare swap — otherwise sealed secrets become undecryptable. (I can write this migration.)
2. **Audit for damage:** query for any orders confirmed via `evidence IN ('WEBHOOK','DEVICE')` with `source IN ('EMAIL','BANK_API')` or via `text-alert`, and any `users` rows with null/non-scrypt `password_hash`.
3. **Run the VPS recon** (compromise remnants + hardening) — commands provided separately.

### Phase 1 — Code hardening (I implement; deploy *after* Phase 0 step 1)
Fail-closed secret guards (C1/C4/H2/H3/H8) · env-gate the `x-sandbox` bypass (C2) · stop trusting body `source` (C3) · remove the prod demo-login path (C5) · amount validation on confirm (H1) · real auth on `text-alert`/`agent-debug` (H4) · session-scoped binding on `email-config` (H5) and `capture-rrn` (H6) · privilege guard on `set-password` (H7) · `timingSafeEqual` on device routes (M1) · bind timestamp+nonce into the signed payload (M2).

### Phase 2 — Structural hardening (follow-up)
Per-device signing keys (retires the shared-secret model) · server-side session store with revocation (M6) · enforce device binding (M3) · login rate-limit/lockout (M4) · enforce MFA for sensitive roles (M7) · never send unsigned callbacks (M5) · move the vault to KMS/HSM.

### Phase 3 — Server hardening (from VPS recon output)
SSH (`PermitRootLogin`/`PasswordAuthentication`), firewall, nginx TLS + security headers, fail2ban, OS security patches, `.env.local` file permissions, and confirming no compromise remnants remain.
