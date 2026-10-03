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
- The dashboard's "Merchant" is a `providers` row; its "Bankers" are `merchants` rows. Page URLs follow the dashboard's words: Merchants at `/merchants` (`app/merchants`), Bankers at `/bankers` (`app/bankers`), the merchant portal's bankers at `/merchant-portal/bankers`. Until 2026-10-03 they were `/providers` and `/merchants`; `next.config.ts` redirects the old merchant URLs, and `app/merchants/[id]/page.tsx` sends an old banker id on to `/bankers/{id}`. API paths (`/api/providers`, `/api/merchants`) keep the table names. The flow is selected on the merchant (`providers.payin_flow`) and inherited by its bankers; a banker's own (`merchant_payment_config.payin_flow`) wins. `UNSET` keeps the old inferred routing.
- Rules live in `apps/admin-dashboard/src/lib/payin-flow.ts` (pure) and `payin-flow-store.ts`. Order creation enforces them: a P2P merchant is never sent to a gateway, an Intent merchant never falls back to a UPI ID.
- APIs: `/api/v1/p2p/order`, `/api/v1/intent/order` and the general `/api/v1/katana-pay/order` share one handler (`lib/katana-order-api.ts`) and one request/response contract. Keep them identical.
- Tables: `vendor_payin_orders` is the shared core; `katana_p2p_orders` (`P2P-…`) and `katana_intent_orders` (`INT-…`) hold each flow's own columns and are maintained by a trigger, never by application writes.
- Admin UI: Payment Management → Pay-in Flows, P2P Pay-ins, Intent Pay-ins.

## Merchant services: pay-in, pay-out or both
A merchant (`providers` row) is onboarded for pay-in, pay-out or both: `providers.services` (`PAYIN` / `PAYOUT` / `BOTH`; `UNSET` for every merchant from before, which may do both). It is chosen in the create journey together with the pay-in flow, and bankers obey their merchant's; a banker has no setting of its own.
- Create and set up are one journey, a question at a time (`components/merchant/onboarding-wizard.tsx`): name and code, contact, services, how customers pay, the default flow (Both only), logins, review. For a merchant from before it starts at services, pre-filled from `suggestChoice` (`GET /api/providers/{id}/onboarding-choice?suggest=1`: its bankers' pay-ins by flow, payouts and setup over 90 days); staff confirm. "Default flow" (`payin_active_flow`) is the flow orders take when they don't name one: the general order API and v2. The P2P and Intent APIs always use their own.
- A merchant code is unique: `GET /api/providers/code` builds one from the name (`lib/merchant-code.ts`) and says whether a code is free; the journey checks as it is typed and blocks a taken one, and `POST /api/providers` with `create_only` refuses it (`409 CODE_TAKEN`). Without `create_only` that route updates the merchant that has the code, as it always did.
- Rules in `lib/merchant-services.ts` (pure), storage in `merchant-services-store.ts`, UI in `components/merchant/services.tsx`. Changes are recorded in `provider_services_history`.
- Enforced where the money moves, not in the UI, by one check: `serviceRefusal(merchantCode, "PAYIN" | "PAYOUT")` (`403`, `PAYIN_NOT_ENABLED` / `PAYOUT_NOT_ENABLED`). It is called in `createKatanaOrder`, `/api/pay`, `runCheckout`, `createPayout` (`lib/fifo-payout.ts`), the payout create and beneficiary routes, and FIFO `createOrder`. A new way to take a pay-in or send a payout must call it. Settlements Katana pays a merchant (`lib/payout.ts`) are not a merchant payout and are not gated. An order already open when a service is switched off can still be paid.
- `merchant-services-store.ts` imports only `lib/pg` and the banker-to-merchant lookup so the cores can import it; what a banker still needs is in `lib/merchant-setup.ts`.
- A merchant that takes pay-ins needs a flow; a pay-out only merchant has none (`validateOnboardingChoice`).
- Go-live: advancing a banker's Approval step runs the `SETUP` gate (`gateSetup`, `bankerSetup`): a flow the merchant is on must be ready (P2P: settlement UPI ID; Intent: pay-in gateway; with Both, the flow in use). A missing one refuses the step unless a Super Admin overrides it with a note. A payout gateway is optional.
- The "Activate live mode" checklist follows the choice (`liveChecklistNeeds`): UPI ID for P2P, pay-in gateway for Intent, and for a pay-out only merchant a successful test payout instead of a test payment. An unset merchant keeps the old checklist.
- Test payouts: a payout made with a test key goes to the banker's payout gateway's sandbox when it has TEST payout credentials, and otherwise to Katana's own payout sandbox (`lib/payout-providers/sandbox.ts`, provider `SANDBOX`). In the sandbox, .99 succeeds at once, .13 fails, and anything else succeeds after 10 seconds. It is an ordinary payout connector, so the verify sweep and "Check status" settle it. No ledger entries, no operator queue, no maker-checker. A beneficiary registered with a test key is approved at once and is payable in test mode only (`fifo_beneficiaries.livemode`, fifo 0020); test and live beneficiaries are separate lists.
- Merchant readiness (`/merchant-readiness`, `merchantReadiness`): every merchant, its choice and what each banker is missing; the place to choose for a merchant that has nothing selected. `GET /api/providers/{id}/onboarding-choice?services=&flow=&active=` answers "what if" before a change is saved (`ReadinessPreview`); `PUT` saves services and flow together. The monitor raises `onboarding:setup_missing` for a live banker missing something required.
- Pay-out only merchants are left off the Pay-in Flows lists, and their portals hide the pay-in pages (`PAYIN_ONLY` in each `portal-shell.tsx`).
- A test order on the Intent flow never reaches a gateway; it is still written as `channel_type = 'INTENT'` (`channel_id = 'SANDBOX'`), so the Intent status API finds it. Its dashboard "simulate credit" confirms it as its gateway would, not through the bank-credit reconciler.

## Pay-in limits, status history and ops automation
- Limits are checked in `createKatanaOrder` before any gateway is asked: rate, min / max ticket, the UPI ceiling and the day's total (India time). Rules in `lib/payin-limits.ts` (pure), storage in `payin-limits-store.ts`; a banker's own (`merchant_payment_config.payin_*`, rupees) win over the platform defaults (`PAYIN_*` env). Refusals are `422` / `429` with `code`, `field`, `limit`, `actual`. A replayed `txnid` is answered before the limits and is never refused by them.
- A blocked, suspended or terminated banker (or one whose merchant is) takes no orders: `403`, `MERCHANT_BLOCKED` / `MERCHANT_SUSPENDED`.
- Two clocks on a pay-in (`lib/katana-pay.ts`): the customer has `PENDING_EXPIRY_SECONDS` (15 minutes) to pay; a live gateway order is then kept `PENDING` for a confirmation window (`PAYIN_CONFIRM_WINDOW_SECONDS`, or `…_<GATEWAY>` for one gateway; off by default, at most 24h) before it is told Expired. Every path that expires an order passes `orderExpirySeconds(meta, livemode)` to `resolveKatanaStatus`; a new one must too. In the window the pay page and `/pay/{id}/go` offer no way to pay (`inConfirmWindow`). v2 `expires_at` is when Expired is sent, window included; the pay-status `expires_at` stays the customer's 15 minutes. P2P and test orders have no window.
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

## Starter kit
A banker's integration kit as chat messages to paste into WhatsApp or Telegram (`lib/starter-kit.ts`, pure; facts in `starter-kit-store.ts`; `GET /api/merchants/{id}/starter-kit?format=whatsapp|telegram|plain`; card on the staff banker page's Developer tab and the merchant portal's banker page). Super Admin and the banker's merchant (`PROVIDER`) only.
- It follows the setup: services decide whether pay-in and payout messages are included, the flow decides the order endpoint, the webhook version decides how a callback is checked, and the live checklist comes from `activationState`.
- It carries the test Key + Salt in full, and makes a test pair when the banker has none. The live Key only, never the live Salt.
- Every message stays under 3,900 characters (Telegram's limit is 4,096) and names no gateway. Its example commands are run as pasted by the e2e suite, so a change to an order or payout contract must change the kit too.

## Merchant and banker portals: easy to use
Both portals share one frame (`components/portal/portal-frame.tsx`); each `portal-shell.tsx` only lists its menu. `usePortal()` tells a component which portal it is in (null on staff pages).
- Menu: Home plus a few groups (Payments, Money, Business / Setup, Help); developer pages (Integration, keys, webhooks, API log) sit behind a "Developer tools" switch, remembered per browser and always shown while one is open. On phones a bottom tab bar (Home, Payments, Search, Assistant or Help, Menu) and a drawer; the sidebar is `md:` and up.
- Home (`/merchant-portal`, `/banker-portal`; `components/portal/portal-home.tsx`, `GET /api/portal/home`, `lib/portal-home.ts`, rules in `lib/portal-home-rules.ts`): "Needs your attention" first (money that came in after its order expired or failed, payment messages not reaching their server, payouts failed or on hold, many refused API requests, a paused account), each with one action; then today's money for the Test / Live mode, settlement, and the go-live steps with where each is done. The old dashboards are at `/reports`.
- Search (`/find`, `GET /api/portal/find`, `lib/payment-search.ts`): a txnid, KTN id, UTR, amount (last 3 days) or customer phone, each match told as a short story (`lib/payment-story.ts`, pure). An unlinked UTR also brings up the order it most likely paid. The support assistant's `find_payment` uses the same `traceRows`.
- Words (`lib/plain-words.ts`, `components/portal/plain-status.tsx`): a payment is Paid / Waiting / Failed / Expired / Refunded, a payout Sent / On its way / On hold / Failed / Stopped / Returned; UPI ID, not VPA; "bank reference (UTR)", not RRN. Portals show these words; staff screens and the v2 API keep the v2 four. The integration guides keep the callback's literal values (`STATUS=Captured`, `RRN`) because developers match on them.
- "Customer says they paid" (`components/portal/paid-button.tsx`) on every order that is not Paid (order list, order page, search): opens the assistant with the question filled in (`?ask=…&screenshot=1`) and asks for the screenshot; without the assistant it leads to support.
- Orders (`/orders`) lists the newest orders before anything is searched (`recentOrders`).

## Support assistant (support bot)
A plain-language helper for merchants' payment and integration problems. Staff test it at `/support-bot` (Operations menu; Super Admin, Admin, Support), as one banker or as a merchant with all its bankers. Merchants (`PROVIDER`) and bankers (`MERCHANT`) use it at `/merchant-portal/assistant` and `/banker-portal/assistant` once `SUPPORT_BOT_PORTALS=1`; off by default, and the menu item is hidden while off. Needs `ANTHROPIC_API_KEY` in `.env.local`; without it the API answers `503 NOT_CONFIGURED`.
- Routes (`/api/support-bot`, one set for staff and portals, `lib/support-bot/access.ts`): `GET/POST /api/support-bot` (list; ask, answered as a stream of JSON lines: `step` events, then `done` or `error`), `GET /api/support-bot/{id}`, `GET /api/support-bot/attachments/{id}`, `POST /api/support-bot/feedback`. A portal user reads only its own `PORTAL` conversations (never staff tests); anything else is "not found". `SUPPORT_BOT_DAILY_LIMIT` (default 100) caps a portal scope's questions per India day.
- Scope (`lib/support-bot/scope.ts`): `banker:<code>` or `merchant:<provider id>`. A portal user's scope comes from its session only; the bankers in a scope are resolved again on every question. Tools take no account from the model and every query is limited to `ctx.codes`; with several bankers each row says which account it is from.
- Model per question (`lib/support-bot/router.ts`, pure, no model call): Claude Haiku 4.5 for general questions, Claude Sonnet 5.5 (effort medium) for the merchant's own case (an id, a UTR, an error code, failure words), Claude Opus 5.5 (effort medium) for screenshots and long pastes. Haiku takes no effort and no `fallbacks`; the other two use `fallbacks: "default"`. `SUPPORT_BOT_ROUTING=off` sends all to Opus. Measured locally: about $0.008 (Haiku), $0.02 (Sonnet), $0.06 (Opus, screenshot) per answer, 5–10 s.
- Screenshots (`lib/support-bot/images.ts`): up to 3 per question, shrunk in the browser to 1600 px JPEG, checked by their bytes, kept in `support_bot_attachments` (merchant 0017); the stored message holds a reference that `loadHistory` fills back in. `find_payment` traces a payment from what a screenshot shows (UTR, amount, time, paid-to UPI ID) through orders and money received (`vendor_txn_alerts`, rows tagged with a banker in scope only). A screenshot is never proof of payment. The image itself reaches the model with the customer's name and UPI ID on it; the bot is told not to repeat them.
- `lib/support-bot/`:
  - `knowledge.ts`: instructions (short, everyday words, usually under 60 words, no "also…" extras) and product facts, cached; the error list is built from `V2_ERRORS`. `scopeContext` is the uncached per-conversation line.
  - `tools.ts`: read-only lookups, `get_account_setup`, `list_recent_requests`, `check_signature`, `find_order`, `find_payment`, `list_webhook_deliveries`, `list_recent_payouts`; `TOOL_STEP_LABEL` is what the person sees while each runs.
  - `signature.ts`: names the signing mistake from the request log's hash hint (first four characters and length).
  - `bot.ts`: the tool loop, at most 8 rounds.
  - `store.ts`: merchant 0016 + 0017 tables `support_bot_conversations` (`scope_key`, `channel`), `support_bot_messages`, `support_bot_attachments`.
- UI: `components/support-bot/assistant-chat.tsx` (shared), `portal-assistant.tsx`. Staff see the lookups, model, tier and cost under each answer and rate with a note; merchants get thumbs only. Animation classes are `sb-*` in `globals.css`.
- Tools return only what an answer needs, through the merchant view of the data, with gateway names stripped. No Salt, secret or customer UPI ID/phone ever comes from a tool. The answer is scrubbed again before it is shown.
- Answers are plain text with no Markdown bold or headings (it may be sent on WhatsApp later). Times reach the model already in IST (`ist()` in `tools.ts`); keep it that way rather than asking the model to convert.
- History is append-only (thinking blocks kept as returned; a turn on another model ignores them); a turn always ends on an assistant message. Ratings and notes on answers are the start of the bot's test set.
- A new fact merchants need belongs in `knowledge.ts`; a new lookup is a tool in `tools.ts` scoped by `ToolContext`, plus a step label and a check in the e2e suite.
- Before production: a compliance decision on sending order details and payment screenshots to Anthropic (outside India), the key in the server's `.env.local`, `pnpm install` (new dependency), merchant 0016 and 0017 applied, then `SUPPORT_BOT_PORTALS=1` when merchants should get it.

## Naming: the pay-in product is Katana Pay
Katana's own pay-in product is **Katana Pay**: `vendor = 'KATANA'` on `vendor_payin_orders`, `merchant_payment_config.katana_pay`, `lib/katana-pay.ts` (order core), `lib/katana-order.ts` (create / confirm), `/api/vendors/katana/*`, `/vendors/katana`. "PoolPay" was a name carried over from the BRD; do not use it for anything new.
- The upstream integration and gateway connectors that carried the old name were removed on 2026-10-01 (never used in production), and the routing rail, its adapter code and ledger accounts are `katana` / `KATANA`. The callback secret setting is `VENDOR_SECRET_KATANA`.

## Testing
- Unit tests: `go test ./...` per service, `pnpm test` for Node.js
- Admin dashboard: `pnpm test` (pure rules, `src/lib/__tests__`) and `pnpm test:integration` (`tests/integration`, writes to the database in `.env.local` and refuses to run unless it is local)
- Admin dashboard end to end: `pnpm dev`, then `pnpm test:e2e` (`tests/e2e`). It signs in over HTTP as a local staff user it creates (`pnpm e2e:staff`; password in `.env.local` as `E2E_STAFF_PASSWORD`), creates a merchant for every services and flow combination, takes its banker to go-live and calls every order and payout API. It also:
  - runs test payouts through the payout sandbox
  - builds each banker's Starter Kit and runs its example commands as pasted
  - runs every support bot lookup on a real banker; no model call, so it costs nothing

  Local database and localhost only; test orders, no gateway. Add a combination, a new order route, or a new bot tool there.
- Integration tests: `go test -tags=integration ./...` (requires Docker deps)
- Proto linting: `buf lint` in proto/ directory
- Breaking change detection: `buf breaking` against main branch
