# Recovery state — 2026-06-15

The working tree was wiped mid-session on 2026-06-15 around 01:18 local time.
The `.git/` directory, all services, packages, libs, proto, infra, tools, configs,
and most application source were destroyed.

The user chose **Option 2: reconstruct from scratch**. This document is the merge
guide if a backup is later restored.

## Contents of this checkout — three confidence tiers

### Tier A — faithful reproduction (verbatim from session context)
These files were read or authored during the session and reproduced verbatim. If
a backup is restored, **prefer the backup** but the conflict will usually be a
no-op.

| Path | Source |
|---|---|
| `docs/PRODUCT_VISION.md` | Read in full |
| `CLAUDE.md` | Read in full (project instructions) |
| `apps/admin-dashboard/package.json` | Read in full |
| `apps/admin-dashboard/src/middleware.ts` | Authored this session |
| `apps/admin-dashboard/src/lib/scope.ts` | Authored this session |
| `apps/admin-dashboard/src/lib/auth.ts` | Read in full |
| `apps/admin-dashboard/src/lib/pg.ts` | Read in full |
| `apps/admin-dashboard/src/lib/nav.ts` | Read in full |
| `apps/admin-dashboard/src/app/layout.tsx` | Partially read; final on-disk version is the killed agent's improvement (with standalone-shell switch) |
| `apps/admin-dashboard/src/app/api/auth/login/route.ts` | Read in full |

### Tier B — partial reproduction (refactored from a read original)
The body was read; the version here has been adapted to use `gateOrResponse`
and persona-derived `WHERE` clauses per `lib/scope.ts`. If a backup is restored,
**prefer the backup** — these refactors will need to be re-applied on top.

| Path | What's changed |
|---|---|
| `apps/admin-dashboard/src/app/api/providers/route.ts` | Added persona gate + scope filter for PROVIDER |
| `apps/admin-dashboard/src/app/api/merchants/route.ts` | Added persona gate + scope filter for PROVIDER/MERCHANT; PROVIDER auto-mapping on lead create |
| `apps/admin-dashboard/src/app/api/sub-mids/route.ts` | Added persona gate + scope filter; PROVIDER restricted to mapped merchants |

### Tier C — reconstruction from PRODUCT_VISION.md + standard patterns
**These files did not exist in session context. They were invented from the spec
and shadcn-ish conventions.** If a backup is restored, **delete these and prefer
the backup**:

- `apps/admin-dashboard/tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `next-env.d.ts`
- `apps/admin-dashboard/src/app/globals.css` (CSS tokens are invented)
- `apps/admin-dashboard/src/lib/utils.ts` (`cn`, `formatDateTime`, `formatAmount`, `statusVariant`)
- `apps/admin-dashboard/src/components/providers.tsx`
- All `src/components/ui/*` (button, card, badge, dialog, input, label, data-table)
- All `src/components/layout/*` (sidebar, header, page-header, coming-soon, logout-button)
- `src/app/login/page.tsx`, `src/app/page.tsx`, `src/app/error.tsx`, `src/app/not-found.tsx`
- All `src/app/api/auth/{logout,me}/route.ts`, `src/app/api/health/route.ts`
- All `src/app/api/{checkout,reserves,commission,kyb,risk,payout,settlement/batches,ledger/balance,partner-data}/route.ts`
- All `src/app/api/admin/api-keys/{route,issue}/route.ts`
- All `src/app/api/merchants/[id]/route.ts`
- All `src/app/provider-portal/**/*` and `src/app/merchant-portal/**/*`
- All `src/app/{providers,merchants,sub-mids}/page.tsx` (admin SUPER_ADMIN versions)
- All other `src/app/<page>/page.tsx` (the ComingSoon placeholders for 30+ pages)

The DB schemas these routes assume (table names, columns) are derived from
`PRODUCT_VISION.md` §3 and from the four `route.ts` files that were read. They
may not match the original Postgres migrations exactly. The reconstructed routes
will return 503 ("Service not initialized") when columns differ — that's the
intended fail-soft behavior in `lib/pg.ts:pgError`.

## NOT recovered, NOT reconstructed

- All Go microservices (`services/`) — code, configs, migrations.
- All shared Go libs (`libs/gokit`), Python SDK.
- All shared TypeScript packages (`packages/`).
- Protobuf definitions (`proto/`) — single source of truth for API contracts.
- Infrastructure (`infra/`) — Terraform, Helm, K8s, ArgoCD.
- Tools (`tools/`) — Docker Compose, Tilt, generators.
- Repo-root build config: `Taskfile.yml`, `Makefile`, `pnpm-workspace.yaml`, `turbo.json`, `pnpm-lock.yaml`, `go.work`, `go.work.sum`, `renovate.json`, `README.md`.
- `src/lib/grpc-client.ts`, `src/lib/integrations-catalog.ts`, `src/lib/vendor-sig.ts`.
- All database schemas / migrations.
- All tests (E2E suite of 120 assertions referenced in commit `871cd1c`).
- `FEATURE_MAPPING.md`, brochure docs, onboarding docs, architecture docs.
- Git history (`.git/`) — including these last six commits:
  - `0295dd7 docs(product): PRODUCT_VISION.md`
  - `ed5ee19 feat(auth+integrations): persona schema + auth API + integrations catalogue`
  - `871cd1c test(e2e) + fix: full UI/Integration/SMOKE/UAT/Perf/Regression suite`
  - `1484007 fix(reserve+settlement): live-run fixes`
  - `7be6098 test(vendor-sig) + chore(dashboard): verify Path 2`

## Build status

The reconstructed dashboard builds clean:
- `pnpm install --ignore-workspace` — succeeds
- `pnpm typecheck` — passes
- `pnpm build` — succeeds; 70+ routes compiled

It will not **function** end-to-end until the Go services and DB migrations are
restored — the BFF queries tables that don't exist yet.

## Recovery options the user should still try

1. macOS Trash (Finder → Trash, search for "6SenAI").
2. macOS Time Machine (rewind to before 2026-06-15 01:18).
3. iCloud Drive version history (if `~/Desktop` is iCloud-synced).
4. Any git remote (GitHub/GitLab/Bitbucket) the project was pushed to.
5. VS Code local history: `~/Library/Application Support/Code/User/History/`.
6. JetBrains local history: `~/Library/Caches/JetBrains/<IDE>/LocalHistory/`.

If a backup is restored, **delete this directory first** to avoid the
reconstructed files masking older versions in the merge.
