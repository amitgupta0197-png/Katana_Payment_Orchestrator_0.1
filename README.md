# Katana — Payment Orchestrator dashboard

Reconstructed Next.js dashboard for the Katana payment orchestration platform.
See `docs/PRODUCT_VISION.md` for the full product spec and `RECOVERY.md` for the
provenance of every file in this repo.

## What's in this repo

```
apps/admin-dashboard/   # Next.js 15 App Router — the BFF + UI for all three personas
docs/                   # PRODUCT_VISION.md (source of truth)
tools/                  # docker-compose + migrations + seed for the Postgres tier
RECOVERY.md             # Per-file recovery provenance
```

## Quick start (5 minutes)

The dashboard talks to a Postgres container that holds 26 logical databases
(one per microservice) — `apps/admin-dashboard/src/lib/pg.ts` is the source of
truth for the database names.

```bash
# 1. Start Postgres (uses the existing 6senai-pgdata volume if present)
docker run -d --name 6senai-postgres \
  -v 6senai-pgdata:/var/lib/postgresql/data \
  -p 5432:5432 \
  -e POSTGRES_USER=sixsenai \
  -e POSTGRES_PASSWORD=sixsenai_pg_2024_secure \
  --restart unless-stopped \
  postgres:16-alpine

# 2. If the volume is fresh (no existing data), bootstrap minimal schema + seed
bash tools/bootstrap-db.sh

# 3. Run the dashboard
cd apps/admin-dashboard
pnpm install --ignore-workspace
cp .env.example .env.local         # adjust if needed
pnpm dev                            # → http://localhost:3100
```

## Login

Three demo users, password `demo`:

| Email                 | Persona     | Lands on            |
|-----------------------|-------------|---------------------|
| admin@katana.dev      | SUPER_ADMIN | `/`                 |
| provider@katana.dev   | PROVIDER    | `/provider-portal`  |
| merchant@katana.dev   | MERCHANT    | `/merchant-portal`  |

## What works end-to-end

- **Login + persona-scoped session cookie** (`HMAC-SHA256` signed; verified in
  both Node and Edge runtimes — see `src/middleware.ts` and `src/lib/auth.ts`).
- **Middleware route guards** (`src/middleware.ts`):
  - Unauth → `/login?next=…`
  - Provider/Merchant blocked from Super-Admin sections (`/admin/*`, `/tenants`,
    `/routing`, `/pg-adapter`, `/bank-adapter`, `/crypto-rail`, `/integrations`,
    `/channels`, `/fund`, `/admin-log`, `/agents`, `/api/admin/*`, etc.)
  - `/provider-portal/*` only for PROVIDER; `/merchant-portal/*` only for MERCHANT
- **Persona-scoped SQL** on every list endpoint (`src/lib/scope.ts`):
  - `SUPER_ADMIN` — full visibility
  - `PROVIDER` — only merchants mapped via `provider_merchant_mappings`
  - `MERCHANT` — only own row
- **56 pages** rendering real data tables from the DB
- **30+ API routes** under `src/app/api/`
- **3 UI shells**: admin sidebar (Super-Admin), Provider portal, Merchant portal

## What's NOT in this repo (and where to add it)

This repo contains the dashboard + BFF only. The full Katana platform also needs:

| Concern | Status | Notes |
|---|---|---|
| Go microservices (`services/`) | Missing | `auth`, `iam`, `notification`, `audit`, `config`, etc. |
| Proto definitions (`proto/`) | Missing | Source of truth for gRPC contracts |
| Per-service DB migrations | Partial | `tools/migrations/` has minimum schema; original migrations not recovered |
| Shared TS packages (`packages/`) | Missing | UI library, SDK, configs |
| Go libs (`libs/gokit`) | Missing | Shared OTel + logging + config |
| Infra (`infra/`) | Missing | Terraform / Helm / K8s / ArgoCD |
| Tools (`tools/`) | Partial | Has Postgres compose + bootstrap; no Tilt / generators |
| E2E suite | Missing | 120 assertions referenced in prior commits |
| Vault for secrets | Not deployed | Per `PRODUCT_VISION.md` §5 |
| Webhook receiver + retry queue | Deferred | `PRODUCT_VISION.md` Phase G |
| Telegram bot + 8 AI agents | Deferred | `PRODUCT_VISION.md` Phase D |
| Pen test / SOC-2 / RBI PA license | Pre-GA | External processes |

## Project conventions

- **All inter-service comms** via gRPC; external APIs are REST/GraphQL through
  the BFF.
- **Every service has its own DB schema** — no shared schemas.
- **OTel for all instrumentation** — traces, metrics, logs.
- **Idempotency**: every external call carries a merchant-owned `order_id`.
- **No persona sees data outside its scope** — enforced at three layers
  (middleware route guard, BFF SQL WHERE, UI nav filter).

See `docs/PRODUCT_VISION.md` §1.2 for product principles, §3 for per-page CRUD,
§4 for executable state machines, §5 for scalability targets, §6 for the GTM
checklist.

## Where the secrets live (or should)

Today: plaintext env vars in `.env.local`. Production target: HashiCorp Vault
with the BFF resolving secrets on demand via short-lived tokens. `secret_ref`
columns in the DB already point at `vault://…` paths but no Vault is wired up.
**Rotate `SESSION_SECRET` in any non-dev environment**, otherwise sessions are
forgeable.

## Production-readiness checklist

`PRODUCT_VISION.md` §6 is the canonical list. Quick state:

- [ ] OWASP top 10 review (XSS, SQLi, IDOR)
- [ ] Pen test on `/api/auth`, `/api/vendors/*`, `/api/admin/*`
- [ ] MFA enforcement for SUPER_ADMIN + PROVIDER OWNER
- [ ] Rate limiting on `/api/auth/login`
- [ ] Secret rotation runbook
- [ ] RBI Payment Aggregator licence gap analysis
- [ ] PCI-DSS scope statement
- [ ] GDPR / DPDP data-subject access flow
- [ ] Chaos test: kill Postgres replica during settlement run
- [ ] Webhook retry queue with exponential backoff
- [ ] Idempotency replay tests
- [ ] OTel traces wired for every BFF → service hop
- [ ] Per-vendor latency + sig-failure-rate dashboards
- [ ] DR: RPO ≤ 5 min, RTO ≤ 30 min; tested cross-region failover

None of the above ship from a code repo alone — each requires deployment,
external attestation, or sustained operational discipline. The reconstructed
code in this repo is the **foundation** they sit on top of, not the whole thing.
