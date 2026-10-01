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
The gateways behind Katana (PayU, Razorpay, Cashfree, CCAvenue, PhonePe PG, Paytm PG, PoolPay, RubyVault, iSmartPay, and any added later) are internal. Their names, ids, error text and support addresses must never reach a merchant.
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

## Naming: Katana Pay is ours, PoolPay is a gateway
Katana's own pay-in product is **Katana Pay**: `vendor = 'KATANA'` on `vendor_payin_orders`, `merchant_payment_config.katana_pay`, `lib/katana-pay.ts` (order core), `lib/katana-order.ts` (create / confirm), `/api/vendors/katana/*`, `/vendors/katana`. Never call it PoolPay.
- "PoolPay" now means only the upstream gateway of that name (`lib/poolpay.ts`, `lib/payin-providers/poolpay.ts`, `lib/payout-providers/poolpay.ts`, `/api/gateway/poolpay/*`, the `POOLPAY_*` and `VENDOR_SECRET_POOLPAY` environment names, the routing engine's `POOLPAY` rail codes). Like every gateway it is never named to a merchant.
- `/api/v1/poolpay/order` and `/api/vendors/poolpay/callback` are kept as aliases for existing integrations; do not add to them.

## Testing
- Unit tests: `go test ./...` per service, `pnpm test` for Node.js
- Integration tests: `go test -tags=integration ./...` (requires Docker deps)
- Proto linting: `buf lint` in proto/ directory
- Breaking change detection: `buf breaking` against main branch
