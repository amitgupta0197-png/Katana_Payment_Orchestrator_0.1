# Katana Payment Orchestrator

## Project Overview
Katana is a payment orchestration platform built on a microservices architecture and deployed across AWS, GCP, and Azure. Monorepo managed with Turborepo (JS/TS), Go workspaces, and Taskfile as the universal orchestrator. (Repo path and Go module paths still use the original `6senai` namespace to keep gRPC contracts and the live stack intact — code identifiers do not affect product branding.)

## Repository Structure
- `services/` - Go microservices (auth, iam, notification, audit, config) and Node.js BFF
- `apps/` - Frontend applications (Next.js admin dashboard, developer portal)
- `packages/` - Shared TypeScript packages (UI components, SDK, configs)
- `libs/` - Shared Go libraries (gokit) and Python SDK
- `proto/` - Protobuf definitions (single source of truth for API contracts)
- `infra/` - Terraform modules, Kubernetes manifests, Helm charts, ArgoCD configs
- `tools/` - Docker Compose, Tilt, developer scripts, generators
- `docs/` - Architecture decisions, API specs, runbooks, onboarding

## Key Commands
- `task setup` - One-command development environment setup
- `task build` - Build all services and packages
- `task test` - Run all tests
- `task lint` - Run all linters
- `task proto:gen` - Generate code from protobuf definitions
- `task docker:deps` - Start dependency containers (Postgres, Redis, Kafka)
- `task docker:up` - Start full local stack

## Conventions
- Go services follow `cmd/server/main.go` + `internal/{handler,service,repository,config}` structure
- All inter-service communication uses gRPC (defined in `proto/`)
- External APIs are REST (via gateway) and GraphQL (via BFF)
- Every service has its own database schema - no shared databases
- Feature flags managed via config-service, not code-level toggles
- Use OpenTelemetry for all instrumentation (traces, metrics, logs)
- Terraform modules are cloud-specific; application code is cloud-agnostic
- Git strategy: trunk-based development with short-lived feature branches

## Hard rule: never name a payment gateway to a merchant
The gateways behind Katana (PayU, Razorpay, Cashfree, CCAvenue, PhonePe PG, Paytm PG, RubyVault, iSmartPay, and any added later) are internal. Their names, ids, error text and support addresses must never reach a merchant.
- "Merchant" means everyone who is not Katana staff: any request signed with a merchant Key + Salt, PROVIDER / MERCHANT / BANKER sessions, the customer on the hosted pay page, callbacks, exports, and the public guides and API docs.
- Super Admin and other staff screens keep the real names; operators need them.
- Keep internal messages precise. Scrub at the boundary with `apps/admin-dashboard/src/lib/merchant-safe.ts`: `merchantSafeBody` / `merchantSafeError` for API responses, `merchantSafeChannel` / `stripGatewayNames` for labels, `seesGatewayNames(persona)` to tell staff from merchants.
- Any new merchant-facing route, page, response field or doc must go through it. Say "payment processor" or "gateway", never the brand. Do not add response keys named after a gateway.

## Pay-in flows: P2P / Intent / Both
Katana takes pay-ins on two flows, and every merchant is explicitly on one: P2P (payer pays the banker's own UPI ID, proven by a bank credit), Intent (a gateway issues and confirms the payment) or Both (with one of the two selected as in use).
- The dashboard's "Merchant" is a `providers` row; its "Bankers" are `merchants` rows. The flow is selected on the merchant (`providers.payin_flow`) and inherited by its bankers; a banker's own (`merchant_payment_config.payin_flow`) wins. `UNSET` keeps the old inferred routing.
- Rules live in `apps/admin-dashboard/src/lib/payin-flow.ts` (pure) and `payin-flow-store.ts`. Order creation enforces them: a P2P merchant is never sent to a gateway, an Intent merchant never falls back to a UPI ID.
- APIs: `/api/v1/p2p/order`, `/api/v1/intent/order` and the general `/api/v1/katana-pay/order` share one handler (`lib/katana-order-api.ts`) and one request/response contract. Keep them identical.
- Tables: `vendor_payin_orders` is the shared core; `katana_p2p_orders` (`P2P-…`) and `katana_intent_orders` (`INT-…`) hold each flow's own columns and are maintained by a trigger, never by application writes.
- Admin UI: Payment Management → Pay-in Flows, P2P Pay-ins, Intent Pay-ins.

## Pay-in limits, status history and ops automation
- Limits are checked in `createKatanaOrder` before any gateway is asked: rate, min / max ticket, the UPI ceiling and the day's total (India time). Rules in `lib/payin-limits.ts` (pure), storage in `payin-limits-store.ts`; a banker's own (`merchant_payment_config.payin_*`, rupees) win over the platform defaults (`PAYIN_*` env). Refusals are `422` / `429` with `code`, `field`, `limit`, `actual`. A replayed `txnid` is answered before the limits and is never refused by them.
- A blocked, suspended or terminated banker (or one whose merchant is) takes no orders: `403`, `MERCHANT_BLOCKED` / `MERCHANT_SUSPENDED`.
- `vendor_payin_status_history` records every status change of a pay-in. It is written by a trigger and is append-only; never write to it from application code.
- Scheduled work is HTTP cron routes under `/api/v1/cron/*` called by the server's crontab, not a queue. New ones use `cronGate` + `runJob` from `lib/jobs.ts` so they leave a heartbeat (`job_heartbeats`); `/api/health?deep=1` and `/api/metrics` report stale ones.
- Compliance flags (`lib/payin-compliance.ts`, `payin_compliance_flags`): the monitor scans live, paid pay-ins for structuring, volume spikes, new-merchant volume, round amounts and the CTR threshold. A flag is a prompt for a person; review goes through `/api/risk/payin-flags`. Staff only.
- Merchants pull their own report from `POST /api/v1/reports/payins` (`lib/payin-report.ts`), signed with Key + Salt over `from|to`.
- `runCheckout` (`lib/checkout-core.ts`) refuses a live, non-simulated run (`LIVE_CHECKOUT_UNAVAILABLE`): its adapters are sandboxes. Do not route live money through it.
- Onboarding gates (`lib/onboarding-gates.ts`, identifier checks in `lib/kyc-validators.ts`) run when a step is advanced and are recorded in `merchant_onboarding_gates`. They check form and Katana's own lists only; nothing is verified with a registry yet. `merchant_status_history` is trigger-written and append-only.
- Secrets kept in an ordinary text column are sealed with `sealText` and read with `openText` (`lib/sealed-text.ts`): webhook signing secrets, mailbox passwords and tokens, TOTP secrets. `openText` also reads the plaintext rows from before; `POST /api/admin/secrets/seal` seals those. A new secret column goes in `SEALED_COLUMNS`.
- Bank account numbers are sealed the same way (`fifo_beneficiaries`, `providers`, `provider_beneficiary_accounts`, and `account_number` inside a settlement's `beneficiary_snapshot`). A sealed value is different every time it is written, so never compare or search on these columns in SQL: read the row by something else and compare after `openText`.
- Sessions: logout revokes that one session (`sid` in the cookie, `fifo_revoked_sessions`); `revokeSessions` ends all of a user's. With `FIFO_MFA_ENFORCE=true` a staff session without two-factor reaches only `/security` and its API (`lib/mfa-policy.ts`, enforced in the middleware and in `gate`). A lost authenticator is reset by a Super Admin from Admin → Users → Danger zone.
- Capture phones: from agent v3.11 each phone signs with its own key (`DeviceKey.kt`, `lib/device-keys.ts`, `vendor_device_keys`) and `verifyDeviceRequest` (async) says which phone a request came from. The key shared by older agents is accepted only for a phone with no key of its own, and for nobody once `AGENT_SHARED_KEY_ACCEPTED=0`. A reinstalled agent has a new key: reset the old one under Transaction intelligence → Devices.
- Gateway performance (`lib/gateway-performance.ts`) is computed from real order outcomes and is staff-only. An unhealthy gateway raises an alert; no traffic is moved, because a merchant has one pay-in gateway. The router and circuit breaker (`lib/routing.ts`, `lib/circuit-breaker.ts`) still serve only the sandbox checkout pipeline.
- When a query selects `id::text` (aliased `id`), `ORDER BY id` sorts by that text ("9" after "12"). Qualify the column: `ORDER BY t.id`.
- A failed webhook signature goes through `recordSecurityEvent` (`lib/security-event.ts`).
- Bank statements (MT940, camt.053) are read by `lib/bank-statement.ts` and imported through `POST /api/v1/bank-feeds/{bank_code}`. Credits go to the reconciler as `BANK_STATEMENT`, a source that never auto-confirms an order: a statement line has a date, not a time. Do not change it to `BANK_API`.
- Live activation: `LIVE_MIN_TEST_PAYMENTS` sets how many test payments the checklist asks for; `LIVE_AUTO_ACTIVATE=1` approves a complete request without a second person. Both default to the old behaviour.
- Payment mail: a linked mailbox is read only once staff approve it (`vendor_email_inboxes.approved`, Admin → Mailboxes), because linking needs no login. A mail is acted on only when `checkSender` (`lib/email-sender-check.ts`) finds the mailbox's own server authenticated it as from a payment provider's domain; a keyword in the sender or subject proves nothing. A new provider's domain goes in `PAYMENT_EMAIL_DOMAINS`.
- Anything that needs a person goes through `raiseAlert` / `setAlert` (`lib/ops-alert.ts`): one Telegram message per condition to the admin chats, repeated only after a quiet period. Scheduled checks live in `lib/ops-monitor.ts`.

## API v2, webhook v2 and the order desk
v2 is a second surface beside v1, over the same pay-in core (`createKatanaOrder` / `confirmKatanaOrder`). Every v1 endpoint and the v1 callback are unchanged; do not "tidy" one into the other.
- `POST /v2/orders`, `GET /v2/orders/{order_id|reference}` (`lib/v2-api.ts`; the path is outside `/api`, let through by the middleware). Auth is `Authorization: Bearer sk_live_… / sk_test_…` (`lib/v2-keys.ts`, `auth.api_keys`); the key decides the mode. Amounts are paise.
- One vocabulary in v2 code, responses and screens: `PENDING` / `SUCCESS` / `FAILED` / `EXPIRED` (`lib/webhook-v2.ts`, pure). No "Captured", no response codes. `gateway` is always null. Errors are `{ code, message, reference }`; a new code goes in `V2_ERRORS` and in `public/katana-v2-guide.html` (a test holds the two together).
- The webhook body and the status API are the same object (`v2Body`). `rrn_is_synthetic` is true when the reference is `genRrn(order id)`: Katana made it, no bank did.
- Webhook version is per banker: `merchants.webhook_version` (`v1` for every banker that existed, `v2` for new rows), `webhook_events` (`ALL` / `PAID_ONLY`), `webhook_secret` (sealed). `sendPayinCallback` branches on it; a v1 banker is never sent v2, and a v2 banker with no signing secret yet is sent the v1 callback (`effective_version`), so a default never leaves a banker without one. `PAID_ONLY` applies to both versions. v2 deliveries carry `X-Katana-Event`, `X-Katana-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")`, `X-Katana-Event-ID` (the same on every retry; a Resend is a new id).
- A callback is attempted 7 times: at once, then after 1m, 5m, 15m, 1h, 6h and 24h. Its own row is sent first (`deliverNow`), then the drain.
- The outbox (`lib/webhook-outbox.ts`) holds both versions; `is_test` rows are portal sample events: one attempt, never retried, status `TEST_FAILED` on failure.
- A merchant or banker login acts on its own bankers' orders only: `orderInScope` (`lib/portal-scope.ts`) on every route that takes an order id. A new such route must call it.
- Order desk: `/api/portal/*` serves the merchant portal, the banker portal and staff from one set of routes, scoped by `lib/portal-scope.ts`. Search and timeline are `lib/order-timeline.ts`. Staff-only detail (actor, evidence, response bodies, request bodies) is decided there, not in the UI.
- `api_request_log` (`lib/api-log.ts`): v2, the v1 Key + Salt order endpoints and `/api/pay`. Bodies are redacted before they are stored; a merchant never reads one.
- Gateway webhooks received are recorded in `gateway_webhook_events` (`lib/gateway-webhook-log.ts`); gateway health (`gatewayHealth` in `lib/gateway-performance.ts`, `/gateway-health`) alerts on no webhook in 24h, median confirmation over 30 min and over 20% paid-after-expiry, through `setAlert` with `email: true`: the admin chats, the banner on every staff page (`/api/ops/alerts`) and a mail to ops (`lib/ops-email.ts`, plain SMTP, inert until `OPS_EMAIL_TO` and `SMTP_*` are set). Staff only.
- Go-live checklist (`lib/gateway-golive.ts`, `/gateway-golive`): saving live gateway credentials starts an account as `VERIFYING`, where it takes only small verification payments (`GOLIVE_VERIFY_MAX_AMOUNT`, `GOLIVE_VERIFY_MAX_ORDERS`), until ping, a webhook-confirmed payment and a status check are recorded and staff set it `LIVE`. An account with no `gateway_golive` row is not gated: that is every account that was live before.

## Naming: the pay-in product is Katana Pay
Katana's own pay-in product is **Katana Pay**: `vendor = 'KATANA'` on `vendor_payin_orders`, `merchant_payment_config.katana_pay`, `lib/katana-pay.ts` (order core), `lib/katana-order.ts` (create / confirm), `/api/vendors/katana/*`, `/vendors/katana`. "PoolPay" was a name carried over from the BRD; do not use it for anything new.
- The upstream integration and gateway connectors that carried the old name were removed on 2026-10-01 (never used in production), and the routing rail, its adapter code and ledger accounts are `katana` / `KATANA`. The callback secret setting is `VENDOR_SECRET_KATANA`.

## Testing
- Unit tests: `go test ./...` per service, `pnpm test` for Node.js
- Admin dashboard: `pnpm test` (pure rules, `src/lib/__tests__`) and `pnpm test:integration` (`tests/integration`, writes to the database in `.env.local` and refuses to run unless it is local)
- Integration tests: `go test -tags=integration ./...` (requires Docker deps)
- Proto linting: `buf lint` in proto/ directory
- Breaking change detection: `buf breaking` against main branch
