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
- Gateway performance (`lib/gateway-performance.ts`) is computed from real order outcomes and is staff-only. An unhealthy gateway raises an alert; no traffic is moved, because a merchant has one pay-in gateway. The router and circuit breaker (`lib/routing.ts`, `lib/circuit-breaker.ts`) still serve only the sandbox checkout pipeline.
- When a query selects `id::text` (aliased `id`), `ORDER BY id` sorts by that text ("9" after "12"). Qualify the column: `ORDER BY t.id`.
- A failed webhook signature goes through `recordSecurityEvent` (`lib/security-event.ts`).
- Bank statements (MT940, camt.053) are read by `lib/bank-statement.ts` and imported through `POST /api/v1/bank-feeds/{bank_code}`. Credits go to the reconciler as `BANK_STATEMENT`, a source that never auto-confirms an order: a statement line has a date, not a time. Do not change it to `BANK_API`.
- Live activation: `LIVE_MIN_TEST_PAYMENTS` sets how many test payments the checklist asks for; `LIVE_AUTO_ACTIVATE=1` approves a complete request without a second person. Both default to the old behaviour.
- Payment mail: a linked mailbox is read only once staff approve it (`vendor_email_inboxes.approved`, Admin → Mailboxes), because linking needs no login. A mail is acted on only when `checkSender` (`lib/email-sender-check.ts`) finds the mailbox's own server authenticated it as from a payment provider's domain; a keyword in the sender or subject proves nothing. A new provider's domain goes in `PAYMENT_EMAIL_DOMAINS`.
- Anything that needs a person goes through `raiseAlert` / `setAlert` (`lib/ops-alert.ts`): one Telegram message per condition to the admin chats, repeated only after a quiet period. Scheduled checks live in `lib/ops-monitor.ts`.

## Naming: the pay-in product is Katana Pay
Katana's own pay-in product is **Katana Pay**: `vendor = 'KATANA'` on `vendor_payin_orders`, `merchant_payment_config.katana_pay`, `lib/katana-pay.ts` (order core), `lib/katana-order.ts` (create / confirm), `/api/vendors/katana/*`, `/vendors/katana`. "PoolPay" was a name carried over from the BRD; do not use it for anything new.
- The upstream integration and gateway connectors that carried the old name were removed on 2026-10-01 (never used in production), and the routing rail, its adapter code and ledger accounts are `katana` / `KATANA`. The callback secret setting is `VENDOR_SECRET_KATANA`.

## Testing
- Unit tests: `go test ./...` per service, `pnpm test` for Node.js
- Admin dashboard: `pnpm test` (pure rules, `src/lib/__tests__`) and `pnpm test:integration` (`tests/integration`, writes to the database in `.env.local` and refuses to run unless it is local)
- Integration tests: `go test -tags=integration ./...` (requires Docker deps)
- Proto linting: `buf lint` in proto/ directory
- Breaking change detection: `buf breaking` against main branch
