# Katana — Product Vision, Onboarding Journeys, 5-Layer CRUD Breakdown, GTM Checklist

> **Audience:** product owner, engineering leads, ops, design.
> **Purpose:** answer "what does Katana actually deliver, to whom, how, and how do we ship it to market without missing the small but critical data inputs."
> **Companion docs:** `FEATURE_MAPPING.md` (feature catalog + implementation status), Blue Print PDF + Architecture Doc PDF (in `Payment_Aggregator/docs/Reference_Documents /`).

---

## 1. Vision

Katana is a multi-tenant **payment orchestration platform** that lets a Super Admin operator (Katana itself) bring multiple **Providers/Agents** onto the platform; each Provider sources **Merchants**; each Merchant operates one Main MID and many Sub-MIDs across multiple payment rails (UPI Intent / Collect / Card / Net Banking / Wallet / QR / Crypto). Money flows in via PG vendors (PoolPay, Quickpay, Razorpay, PayU, Cashfree…), gets routed, risk-checked, ledgered, and flows out via Bank Payouts (RazorpayX, Cashfree Payouts, ICICI CE-Connect, PoolPay/Quickpay payout) and Crypto VASPs (Binance OTC, OKX, Bitget, OnMeta, Transak…). Every event is monitored by Agentic AI agents that report into Telegram groups.

### 1.1 Three first-class personas

| Persona | Who | Default scope | Allowed | Forbidden |
|---|---|---|---|---|
| **Super Admin** | Katana operator | Platform-wide | Approve KYC/KYB, enable settlements, configure global routing, override risk, manage providers + merchants + Sub-MIDs, manage platform pricing | n/a |
| **Provider / Agent** | Sub-admin reselling Katana | Provider-scoped — sees only mapped merchants | Create merchant leads, request Sub-MIDs, upload KYC for mapped merchants, view own commission, raise support tickets | Approve own KYC, enable settlements, change global routing/risk/pricing, access other providers' data |
| **Merchant** | End-customer of a Provider | Merchant-scoped — sees only own data | View own transactions, settlements, reserves, UTR/TXID/payout-ref, raise disputes, manage own API keys | View any other merchant, edit MID/Sub-MID, change platform routing/risk/pricing |

### 1.2 Product principles

1. **No persona sees data outside its scope.** Enforced at three layers: middleware (route guard), BFF (SQL `WHERE` clause derived from `session.scope_id`), and UI (nav items filtered).
2. **No state mutates without an event + audit row.** Every CRUD that changes a thing writes to `event_stream` AND `audit_logs` AND (if state-machine driven) `workflow_transitions`.
3. **No required data is collected later.** Forms validate up-front; we never proceed with `null` on a field a downstream rail or partner needs (e.g. UPI rail needs `beneficiary_vpa`; RTGS needs `beneficiary_ifsc + remarks`; purpose codes constrain amount ranges).
4. **Money data is always pulled, never typed.** Settlement partner data (UTR / payout-ref / TXID / charges) comes from Bank/Payout/Wallet APIs / webhooks / statements — never marked manually.
5. **Idempotency is non-negotiable.** Every external call carries a merchant-owned `order_id`; duplicates return the original.

---

## 2. Onboarding Journeys (the "no missed inputs" view)

### 2.1 Provider Onboarding (P0 — driven by Super Admin)

| Step | Page | Data captured | Validation | State change |
|---|---|---|---|---|
| 1 | `/providers` (Super Admin) | code, legal_name, contact_email, contact_phone, kind ∈ {PROVIDER,AGENT,PARTNER,FRANCHISE}, settlement_currency | code unique, email format, phone 10 digits | `providers` row inserted, `kyc_status=PENDING`, `status=ACTIVE` |
| 2 | `/providers/[id]` → KYC | doc_type ∈ {PAN,GST,CIN,MOA,AOA,BOARD_RESOLUTION,ADDRESS_PROOF,BANK_STATEMENT,OTHER}, file (uploaded → S3), sha256 | sha256 dedupe per provider; mandatory PAN + GST + CIN | `provider_kyc_documents` rows |
| 3 | `/providers/[id]` → Users | email, name, role ∈ {OWNER,OPERATOR,READER} | unique per provider | `provider_users` rows |
| 4 | `/providers/[id]` → Commission | rule_kind ∈ {BPS,FIXED,SLAB}, rate_bps, fixed_fee, currency, valid_from, valid_to | bps 0–10000, fee ≥ 0 | `provider_commission_rules` row |
| 5 | Super Admin reviews `/providers` | sets kyc_status → APPROVED | requires all mandatory docs verified | `workflow_transitions` row, `providers.kyc_status=APPROVED` |
| 6 | Provider can now log in | bank_account_no, bank_ifsc set | IFSC format | provider goes live |

**Inputs we previously missed and now must capture:** `contact_phone` (provider escalation), `settlement_currency` (multi-currency providers), `granted_by` on KYC verification (audit), `low_balance_threshold` per provider for Treasury Agent alerts.

### 2.2 Merchant Onboarding (P1 — driven by Provider, approved by Super Admin)

| Step | Page | Persona | Data captured | Validation | State change |
|---|---|---|---|---|---|
| 1 | `/provider-portal/leads` | Provider | merchant_id, business_name, business_type, expected_volume, contact_email, contact_phone | merchant_id unique per tenant; expected_volume > 0 | merchant lead row |
| 2 | Provider uploads docs | Provider | PAN, GST, CIN, MOA, AOA, board_resolution, address_proof, bank_statement, MCC_DECLARATION, website_url, mobile_app_url | sha256 dedupe; each ≤ 10MB | `kyb_documents` rows |
| 3 | Provider submits bank | Provider | bank_account_no, bank_ifsc, beneficiary_name (must match legal_name), upi_vpa (optional) | IFSC checksum, name match heuristic | `merchant_bank_accounts` row |
| 4 | Provider risk profile | Provider | declared_mcc, declared_avg_ticket, declared_geos[], chargeback_history | declared_mcc ∈ MCC table | `merchant_risk_profiles` row |
| 5 | Super Admin reviews `/kyb` | Super Admin | runs screening (sanctions OFAC/UN/EU), assigns risk_tier ∈ {LOW,MEDIUM,HIGH}, assigned_mcc | risk_tier requires screening_hits = 0 | `kyb_cases.status=APPROVED`, risk_tier set |
| 6 | Super Admin creates Main MID | Super Admin | mid_code (auto or manual), settlement_enabled (defaults FALSE) | unique per merchant | `main_mids` row |
| 7 | Provider requests Sub-MIDs | Provider | sub_mid_code, traffic_mode ∈ {KYC_APPROVED,TRAFFIC}, per_txn_max, daily_amount, daily_count, monthly_amount | mode-dependent | `sub_mids` row, `sub_mid_limits` row, `sub_mid_status_history` row |
| 8 | Super Admin approves Sub-MID | Super Admin | approve_kyc=true, enable_settlement=true | `kyc_status=APPROVED` precondition | `sub_mids.settlement_enabled=true`, auto-upgrade TRAFFIC→KYC_APPROVED |
| 9 | Merchant goes live | — | webhook_url, return_url, API key issued (one-time secret) | webhook URL must be HTTPS | merchant operational; receives credentials |

**Inputs we previously missed:** `declared_avg_ticket` (drives velocity rule auto-tuning), `declared_geos[]` (drives blacklist country filter), `website_url + mobile_app_url` (required for card-network compliance), `MCC_DECLARATION` (separate from generic KYC), `chargeback_history` (drives initial reserve %), name-match heuristic on bank_account_name vs legal_name (regulator requirement).

### 2.3 Bank / UPI / Vendor Integration Onboarding (per-tenant)

For each integration in `/integrations`, the onboarding flow is:

1. **Vendor row created** by Super Admin (already seeded for PoolPay + Quickpay).
2. **Secrets stored** via Vault path reference, never plaintext (`vault://poolpay/live/secret`).
3. **IP whitelisted** at vendor side (egress IP of Katana's outbound NAT).
4. **Sandbox smoke test** (POST a 100 INR payin → callback round-trip → status enquiry).
5. **Live activation** (`vendor_credentials.active=TRUE`, env flipped from sandbox to live).
6. **Webhook URL handed to vendor** (`https://api.katana.io/api/vendors/poolpay/callback`).
7. **First-30-day shadow** (Risk Agent watches sig-verify rate, callback latency, status-enquiry agreement).

---

## 3. Five-Layer Page Breakdown × Persona CRUD

For every page in Katana we describe 5 layers:
- **L1 Purpose** — business problem the page solves
- **L2 Data Model** — primary entity + key fields
- **L3 CRUD × Persona** — what each persona can do (✓ = full, R = read-only, ✗ = blocked)
- **L4 Workflows & Validations** — state machine + input rules
- **L5 Integrations & Telemetry** — external systems hit + events emitted

### 3.1 `/providers` (Provider / Agent Management) — Blue Print P0

- **L1** Manage the sub-admin entities that source merchant traffic.
- **L2** `providers` (code, legal_name, contact_email, kyc_status, status, bank_account, settlement_currency) + `provider_users` + `provider_kyc_documents` + `provider_commission_rules` + `provider_merchant_mappings`.
- **L3** Super Admin: C ✓ R ✓ U ✓ D ✓ (soft delete = status=TERMINATED). Provider: R own only. Merchant: ✗.
- **L4** State machine: `kyc_status: PENDING → IN_REVIEW → APPROVED ⇄ EXPIRED, → REJECTED`. Validations: code unique (per tenant), email RFC5322, phone 10 digits, IFSC checksum if provided, MCC declaration required before APPROVED.
- **L5** Events: `provider.created`, `provider.kyc.advanced`, `provider.activated`. Audit: every status/kyc transition appended to `provider_audit_logs`. Telegram (future): Compliance Agent alerts on docs expiring in 30d.

### 3.2 `/sub-mids` (Main MID + Sub-MID Engine) — P1A

- **L1** Identity model for merchant payment surface.
- **L2** `main_mids` (mid_code, merchant_id, settlement_enabled) + `sub_mids` (sub_mid_code, traffic_mode, kyc_status, settlement_enabled, limits) + `sub_mid_limits` + `sub_mid_status_history`.
- **L3** Super Admin: C ✓ R ✓ U ✓ D — (terminate only). Provider: C — request Sub-MID for mapped merchant; R — own requests only. Merchant: R — own Sub-MIDs.
- **L4** State machine: traffic_mode `TRAFFIC → KYC_APPROVED` (one-way upgrade gated on `kyc_status=APPROVED`). `settlement_enabled` cannot be true unless `kyc_status=APPROVED` (DB constraint).
- **L5** Events: `sub_mid.requested`, `sub_mid.kyc.approved`, `sub_mid.settlement.enabled`. Audit: every transition → `sub_mid_status_history`.

### 3.3 `/merchants` — Merchant master

- **L1** Customer-of-our-customer entity.
- **L2** `merchants` (merchant_id, business_name, kyc_status, risk_status, status) + KYC docs + bank accounts + risk profile.
- **L3** Super Admin: C ✓ R ✓ U ✓ D — (status=TERMINATED only). Provider: C ✓ for mapped, R ✓ mapped, U ✓ KYC + bank only, D ✗. Merchant: R own only, U contact + webhook URL only.
- **L4** State machine: `status: ACTIVE → SUSPENDED → TERMINATED`. KYC sub-machine: `NEW → DOCS_PENDING → IN_REVIEW → APPROVED/REJECTED → EXPIRED`. Bank account name-match check before approval.
- **L5** Events: `merchant.created`, `merchant.kyc.decision`, `merchant.suspended`. Webhook outbound to Provider on status change.

### 3.4 `/integrations` — Channel + API key catalogue

- **L1** Single source of truth for every external integration + the credentials required to run it (sandbox + live).
- **L2** Static `INTEGRATIONS[]` catalogue (27 entries × 11 categories). Future: promote to DB table once ops needs runtime edits.
- **L3** Super Admin: R ✓ (write is via env-var rotation through Vault). Provider/Merchant: ✗.
- **L4** Status states: `not_started → scaffold → implemented`. No state mutation from the UI today — driven by code merges.
- **L5** Reads from `lib/integrations-catalog.ts`. Future: live status from per-vendor health probe + last-callback timestamp.

### 3.5 `/checkout` — Universal payin

- **L1** Order intake for end-customer pay-ins.
- **L2** `checkout_orders` (tenant_id, merchant_id, client_ref, txn_id, amount, currency, method, selected_rail, status).
- **L3** Super Admin: R ✓ all. Provider: R mapped merchants only. Merchant: C ✓ own, R own only.
- **L4** State machine: `INITIATED → PENDING → SUCCEEDED / FAILED / CANCELLED → REFUND_INITIATED → REFUNDED → CHARGEBACK`. Validation: `amount > 0`, `currency = INR` (v1), method matches an enabled rail at routing time. Idempotency: (tenant, idempotency_key).
- **L5** Calls routing-engine for rail pick → calls vendor-gateway (PoolPay/Quickpay) → vendor callback → ledger posting → optional refund flow. Events: `order.created`, `order.routed`, `order.callback.received`, `order.captured`, `order.refunded`.

### 3.6 `/vendors/[vendor]` — PoolPay / Quickpay cockpit

- **L1** Per-vendor adapter cockpit (sandbox dispatcher + production observability).
- **L2** `vendor_credentials`, `vendor_payin_orders`, `vendor_payout_orders`, `vendor_callbacks`, `vendor_balance_snapshots`.
- **L3** Super Admin only.
- **L4** Payin states: `INITIATED → Captured / Pending / Failed / Declined / Cancelled / Settled / Refund*` (RESPONSE_CODE 000/005/029/…/030/031/032). Payout states: `Created → Processing → Completed / Failed / BouncedBack`. Validations: SHA256 payin / HMAC-SHA256-base64 payout; purpose × amount-range from doc Annexure; IFSC required for IMPS/RTGS; VPA required for UPI.
- **L5** External: `https://core.pp-007.com/*`, `https://payout.pp-007.com/*`, Quickpay equivalents. Signature: verified before any state change. Events: `vendor.payin.dispatched`, `vendor.callback.received`, `vendor.signature.failed`, `vendor.payout.completed`.

### 3.7 `/partner-data` — Settlement Partner Data Collection — P7

- **L1** Pull UTR / payout-ref / TXID directly from settlement partners; reconcile against internal records.
- **L2** `settlement_partner_records` + `settlement_partner_sync_runs`.
- **L3** Super Admin: C — via sync, R ✓, U — `match_status` only. Provider/Merchant: R own only.
- **L4** match_status state: `UNMATCHED → MATCHED / BREAK / REVIEW`. Dedupe: UNIQUE INDEX on (partner_kind, partner, COALESCE(utr,''), COALESCE(payout_ref,''), COALESCE(txid,'')).
- **L5** External: Bank API / Payout API / USDT wallet API / SFTP statement / file sync. Events: `partner_data.synced`, `partner_data.matched`, `partner_data.break.opened`.

### 3.8 `/reserves` — Rolling reserve ledger — P8

- **L1** Hold a configurable percentage of merchant payouts until release date.
- **L2** `reserve_ledger` (merchant_id, hold_amount, hold_percent_bps, release_date, release_status, released_amount) + `reserve_release_events`.
- **L3** Super Admin: C ✓ R ✓ U ✓ (release). Provider: R mapped only. Merchant: R own only.
- **L4** State: `HELD → PARTIAL_RELEASE → RELEASED / FORFEITED`. Eligibility: release_date must be reached (or force_early with audit notes).
- **L5** Auto-create on every settlement run (future). Events: `reserve.held`, `reserve.released`, `reserve.partial_released`.

### 3.9 `/risk` — Risk & Velocity — P5

- **L1** Velocity counter rules, blacklist, chargeback workflow.
- **L2** `velocity_rules`, `blacklist_entries`, `chargebacks`, `chargeback_events`.
- **L3** Super Admin: C ✓ R ✓ U ✓ D — (rules disable, blacklist hard-delete). Provider: R mapped only. Merchant: R own only.
- **L4** Chargeback state: `RECEIVED → IN_REVIEW → ACCEPTED / DISPUTED → WON / LOST / EXPIRED`. Validations: blacklist `kind` ∈ {CARD_HASH, CARD_BIN, EMAIL, PHONE, IP, COUNTRY, DEVICE}; velocity_rule cap > 0.
- **L5** Counters in Redis (INCR + TTL = window). Events: `risk.rule.breached`, `risk.blacklist.matched`, `risk.chargeback.received`.

### 3.10 `/kyb` — Payments-specific KYB — Distinct from platform KYC

- **L1** Payments-specific KYB for merchants (separate from platform-level tenant KYC).
- **L2** `kyb_cases`, `kyb_documents`, `kyb_screenings`, `kyb_decisions`.
- **L3** Super Admin: C ✓ R ✓ U ✓ D ✗. Provider: C ✓ open case for mapped merchant; R own. Merchant: R own.
- **L4** Case state: `NEW → DOCS_PENDING → IN_REVIEW → APPROVED / REJECTED / EXPIRED`. Doc kinds: PAN, GST, CIN, MOA, AOA, BOARD_RESOLUTION, ADDRESS_PROOF, BANK_STATEMENT, MCC_DECLARATION, OTHER. Screening providers per case; HIT count > 0 blocks APPROVED.
- **L5** External screening: OFAC, UN, EU, FATF. Events: `kyb.case.opened`, `kyb.screening.hit`, `kyb.decision.taken`.

### 3.11 Summary CRUD matrix — remaining pages

Notation: **C R U D** in cell order; `✓` allowed, `R` read-only, `—` not applicable, `✗` blocked.

| Page | Super Admin | Provider | Merchant |
|---|---|---|---|
| `/` (Dashboard) | R | R (provider-scoped) | R (merchant-scoped) |
| `/admin-log` | R | ✗ | ✗ |
| `/merchant-config` | C R U D | R U mapped only | R own |
| `/payin-order` | R all | R mapped | R own |
| `/payout-order` | R all + trigger | R mapped | R own |
| `/merchant-wallet` | R | R mapped | R own |
| `/fund` | R + initiate | ✗ | ✗ |
| `/payin-data` | R all | R mapped | R own |
| `/payout-data` | R all | R mapped | R own |
| `/channels` | C R U D | R | ✗ |
| `/ledger` | R + verify | R mapped | R own |
| `/payout` (gRPC payouts) | C ✓ R ✓ U ✓ D ✗ | C ✓ for mapped | C ✓ for own (rate-limited) |
| `/settlement` | C R U + trigger | R mapped | R own |
| `/collections` (VA) | C R U D | R mapped | R own |
| `/routing` | C R U D | R | ✗ |
| `/pg-adapter` | C R U D | ✗ | ✗ |
| `/bank-adapter` | C R U D | ✗ | ✗ |
| `/crypto-rail` | C R U D | ✗ | ✗ |
| `/reconciliation` | R | R mapped | R own |
| `/agents` (franchise) | C R U D | R mapped to provider | ✗ |
| `/commission` | C R U D | R own commission | ✗ |
| `/reporting` | R all | R mapped | R own |
| `/tenants` | C R U D | ✗ | ✗ |
| `/admin/users` | C R U D | C — invite into own provider | C — invite into own merchant org |
| `/admin/roles` | C R U D | ✗ | ✗ |
| `/admin/api-keys` | C R U D | C R own | C R own |
| `/admin/assignments` | C R U D | C R own | C R own |
| `/integrations` | R (writes via env) | ✗ | ✗ |

---

## 4. Workflow State Machines (executable)

Encoded as a `lib/workflows.ts` library (deferred — schema is ready). Source-of-truth definitions:

```
KYB:           NEW → DOCS_PENDING → IN_REVIEW → APPROVED ⇄ EXPIRED
                                              → REJECTED
SubMID:        TRAFFIC → KYC_APPROVED (gated on kyc_status=APPROVED, one-way)
ProviderKYC:   PENDING → IN_REVIEW → APPROVED ⇄ EXPIRED → REJECTED
Chargeback:    RECEIVED → IN_REVIEW → ACCEPTED  → WON / LOST
                                    → DISPUTED → WON / LOST
                                    → EXPIRED
PayoutApproval:PENDING → APPROVED → DISPATCHED → COMPLETED / FAILED / BOUNCED_BACK
                       → REJECTED
ReserveRelease:HELD → PARTIAL_RELEASE ⇄ HELD
                    → RELEASED
                    → FORFEITED
PayinOrder:    INITIATED → PENDING → SUCCEEDED → SETTLED → REFUND_INITIATED → REFUNDED → CHARGEBACK
                                  → FAILED / CANCELLED
```

Every transition writes a `workflow_transitions` row with `(workflow_kind, subject_id, from_state, to_state, actor_user_id, actor_persona, actor_scope_id, notes)`.

---

## 5. Scalability Architecture

| Concern | Today | Production target |
|---|---|---|
| **Multi-tenancy** | `tenant_id` on every row | Partition large tables (`vendor_payin_orders`, `event_stream`) by tenant_id |
| **Vendor secrets** | Plaintext env var in dev; `secret_ref` column in DB | All secrets in HashiCorp Vault; BFF resolves on demand with short-lived tokens |
| **Idempotency** | UNIQUE on `(tenant, order_id)` | Plus Redis dedupe-cache for 24h fast path |
| **Webhook ingest** | BFF endpoint per vendor | Edge worker → Kafka topic → service consumes (decouples partner retries from app health) |
| **Audit** | Per-service append-only tables | Plus immutable WORM bucket export for SOC-2 |
| **Read scaling** | Live Postgres | Read-replicas + materialized views (`merchant_daily`, `provider_daily`) refreshed by Kafka projection |
| **Search** | Postgres ILIKE | OpenSearch for txn / order search across millions |
| **Routing** | DB queries per request | Routing rules cached in Redis with version-stamped invalidation |
| **Settlement** | Single batch | Sharded by merchant_id bucket |
| **Reconciliation** | Manual match in UI | Auto-match on UTR / payout_ref / TXID + amount tolerance; UI for breaks only |
| **AI agents** | Not started | Kafka consumer per agent + Telegram bot with role-scoped chats |

---

## 6. Go-To-Market Testing Checklist

| Category | Test | Status |
|---|---|---|
| **Security** | OWASP Top 10 review (XSS, SQLi, IDOR) | TODO |
| **Security** | Pen-test on /api/auth, /api/vendors/*, /api/admin/* | TODO |
| **Security** | Secret rotation runbook | TODO |
| **Security** | MFA enforcement for Super Admin + Provider OWNER | TODO |
| **Security** | Rate limiting on /api/auth/login | TODO |
| **Compliance** | RBI Payment Aggregator licence requirements gap analysis | TODO |
| **Compliance** | PCI-DSS scope statement (we don't store PAN; document) | TODO |
| **Compliance** | GDPR / DPDP data-subject access flow | TODO |
| **Reliability** | Chaos test: kill Postgres replica during settlement run | TODO |
| **Reliability** | Vendor outage simulation (PoolPay returns 5xx for 10min) | TODO |
| **Reliability** | Webhook retry queue with exponential backoff | TODO |
| **Reliability** | Idempotency replay tests | TODO |
| **Performance** | 1K concurrent payins p95 < 200ms | Local: 89ms for 50 ✓; need scaled rig |
| **Performance** | Settlement batch processing 100K txns / hour | TODO |
| **Observability** | OpenTelemetry traces wired for every BFF → service hop | partial (gRPC server-side) |
| **Observability** | Per-vendor latency + sig-failure-rate dashboards | TODO |
| **Observability** | Per-tenant cost dashboard | TODO |
| **Onboarding** | Provider can self-serve from signup → live in < 1 hour | TODO |
| **Onboarding** | Merchant can self-serve from KYB submit → first payin in < 1 day | TODO |
| **Functional** | E2E suite (120 assertions) — passes locally | ✓ (commit 871cd1c) |
| **Functional** | Vendor signing scheme verified against doc cases | ✓ (commit 7be6098) |
| **Disaster recovery** | RPO ≤ 5 min, RTO ≤ 30 min | TODO |
| **Disaster recovery** | Tested cross-region failover | TODO |

---

## 7. Phase-by-Phase Build Roadmap (delta from `FEATURE_MAPPING.md` §E)

| Phase | Scope | Status |
|---|---|---|
| Path 0 (baseline) | Dashboard skeleton + 32 pages + BFF | ✓ (commit 477d4d8) |
| Path 1 | 5 scaffolds→live + 9 RO→mutating | ✓ (dd95a89, 3c93e1e) |
| Path 2A | Vendor adapters (PoolPay + Quickpay) | ✓ (f1d13e3) |
| Path 2B | Provider + Sub-MID | ✓ (c06f320) |
| Path 2C | Partner Data + Reserve | ✓ (66c047c) |
| Path 2 Auth | Persona schema + auth API + integrations | ✓ (ed5ee19) |
| **Now (next session)** | **Middleware persona enforcement + Provider portal + Merchant portal trees** | NEXT |
| Phase D | Telegram bot + 8 AI agents + event_stream | DEFERRED |
| Phase F | UPI AutoPay/mandate recurring | DEFERRED |
| Phase G | Generic webhook receiver + retry queue | DEFERRED |
| Phase H | Per-mode payment modeling | DEFERRED |
| Phase I | Pen test + observability + SOC-2 prep | PRE-GA |
| Phase J | RBI PA licence engagement | LEGAL |

---

## 8. Open product decisions (need product owner sign-off before next session)

1. **Multi-persona switching UX.** Should a user who is both Provider OWNER + Merchant OWNER see a persona-switcher dropdown, or two separate logins?
2. **Settlement frequency.** Today's BP assumes T+1; do we offer T+0 for premium merchants with a higher reserve %?
3. **Reserve formula.** Flat % or dynamic (chargeback-history adjusted)?
4. **Refund SLA.** How aggressively do we surface refund age in merchant portal?
5. **Vendor failover.** If PoolPay returns 5xx, do we silently failover to Quickpay or surface to merchant?
6. **Sub-MID limit auto-tune.** Should declared_avg_ticket auto-set per_txn_max with X% headroom, or always require manual entry?
7. **Provider commission floor.** Minimum commission earn-out per Sub-MID before it pays out?
8. **Merchant API rate limits.** Per-Sub-MID or per-merchant?

---

## 9. What's deferred and why (transparency)

| Item | Why deferred | Trigger to start |
|---|---|---|
| Provider portal tree (`/provider-portal/*`) | Needs persona-scoped queries + middleware first | Next session |
| Merchant portal tree (`/merchant-portal/*`) | Same as above | Next session |
| `lib/workflows.ts` executable library | Schema is ready; needs each page's PATCH route to call it | After portals |
| Telegram bot + 8 AI agents | Separate service; not blocked by anything but is a multi-day build | Phase D |
| Production secrets rotation | Needs Vault deployed | Pre-GA |
| Pen test | Needs feature freeze | Pre-GA |
| RBI PA licence | Legal + business decision | Pre-launch |

This document is the compass. Pages in §3 + workflows in §4 + scalability in §5 + checklist in §6 should drive every next code commit until GA.
