-- Static QR operations & switch model — phase 1 (2026-08-23).
--
-- Katana holds no QR entity at all today: a store's payment endpoint lives only inside the
-- banker's payment app, so moving a store from one QR to another is a manual act nobody can
-- see, approve or replay. This migration adds the smallest schema that lets a BANKER click
-- "switch" on a store it serves and have the endpoint actually move — atomically, once, with
-- a history row that cannot be edited afterwards.
--
-- NAMING — read before using any column here. This repo deliberately decouples persona from
-- the word used in the UI (see apps/admin-dashboard/src/middleware.ts:103-105), and the QR
-- BRD uses the UI words. The mapping, once, so no column below is ambiguous:
--
--   BRD "Banker"   = persona MERCHANT = merchants.merchant_code  (text)  -> banker_code
--   BRD "Merchant" = persona PROVIDER = providers.id             (uuid)  -> provider_id
--   BRD "Store"    = new here; nothing in Katana modelled an outlet before
--
-- So `banker_code` is a merchants.merchant_code and NEVER a providers.code, and `provider_id`
-- is the party the UI calls "Merchant". banker_code carries no FK because `merchants` lives
-- in merchantservice_db while these tables live in providerservice_db, alongside
-- provider_merchant_mappings (which is already the BRD's banker<->merchant mapping).
--
-- SEPARATION OF CONCERNS (BRD module 02, "critical design rule"): ownership, eligibility,
-- allocation and activation are deliberately four different things, stored apart, so a QR
-- can be owned by a banker, approved by an admin, and still be neither allocated nor live:
--
--   ownership   -> banker_qr.banker_code          (immutable after approval)
--   eligibility -> banker_qr.approval_status      (admin controlled)
--   allocation  -> merchant_store_qr_assignment   (a row exists)
--   activation  -> merchant_store_qr_assignment.is_active
--
-- Additive and reversible: nothing outside these four tables is touched, and no existing
-- code path reads them, so the whole feature is inert until a QR is uploaded.

-- ── Banker QR inventory (BRD module 01) ──────────────────────────────────────
-- One row per static QR endpoint a banker can collect on.
CREATE TABLE IF NOT EXISTS banker_qr (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text NOT NULL DEFAULT 'tenant-default',
  banker_code       text NOT NULL,            -- merchants.merchant_code. NOT providers.code.
  provider          text NOT NULL
                    CHECK (provider IN ('GOOGLE_PAY','PHONEPE','PAYTM','MOBIKWIK','OTHER')),
  upi_id            text NOT NULL,            -- the static VPA this QR resolves to
  qr_image_uri      text,                     -- on-disk path, outside the public web root
  qr_image_sha256   text,
  settlement_type   text NOT NULL DEFAULT 'INSTANT'
                    CHECK (settlement_type IN ('INSTANT','T1','MANUAL')),
  daily_limit       numeric(18,2),            -- NULL = no configured ceiling
  remarks           text,

  -- Eligibility. A banker's own upload lands PENDING; an admin-created row is APPROVED at
  -- birth, because making the approver approve itself is theatre. Only APPROVED rows are
  -- ever switch candidates.
  approval_status   text NOT NULL DEFAULT 'PENDING'
                    CHECK (approval_status IN ('PENDING','APPROVED','REJECTED')),
  approved_by       text,
  approved_at       timestamptz,
  rejection_reason  text,

  -- Operational routing state, distinct from approval. Phase 2 (BRD module 03) adds the
  -- payment / settlement / instant-settlement / incident states alongside this one; they are
  -- deliberately separate columns rather than one status, because a QR can accept payments
  -- while its settlement is degraded.
  routing_status    text NOT NULL DEFAULT 'AVAILABLE'
                    CHECK (routing_status IN ('AVAILABLE','RESERVED','ALLOCATED','PAUSED')),

  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN banker_qr.banker_code IS
  'merchants.merchant_code of the owning banker (persona MERCHANT). NOT providers.code.';

-- Duplicate check (BRD module 01: upi_id "Duplicate check"). The same VPA must not be live
-- twice — including under two different bankers, which is exactly how a payment silently
-- lands in the wrong pocket. Scoped to non-rejected rows so a VPA refused once can be
-- re-submitted later after the underlying problem is fixed.
CREATE UNIQUE INDEX IF NOT EXISTS banker_qr_upi_live_uidx
  ON banker_qr (tenant_id, lower(upi_id))
  WHERE approval_status <> 'REJECTED';

-- The switch engine's hot path: this banker's approved, un-paused pool.
CREATE INDEX IF NOT EXISTS banker_qr_pool_idx
  ON banker_qr (banker_code, approval_status, routing_status);

-- Admin approval queue, oldest first.
CREATE INDEX IF NOT EXISTS banker_qr_pending_idx
  ON banker_qr (approval_status, created_at)
  WHERE approval_status = 'PENDING';

-- ── Merchant stores (BRD module 02) ──────────────────────────────────────────
-- An outlet of the party the UI calls "Merchant". The QR is allocated at STORE level, not
-- merchant level, because that is the unit that actually fails: one shop's QR stops
-- scanning while the rest of the chain is fine.
CREATE TABLE IF NOT EXISTS merchant_store (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL DEFAULT 'tenant-default',
  provider_id    uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  code           text NOT NULL,               -- merchant-scoped store code, e.g. S001
  name           text NOT NULL,
  city           text,
  address        text,

  -- BRD module 02: "One active assignment per store unless multi-endpoint mode is explicitly
  -- enabled". PHASE-1 LIMITATION, stated plainly: the unique index below enforces ONE active
  -- assignment per store unconditionally, so this flag is recorded but not yet honoured.
  -- Multi-endpoint needs a trigger (a partial index cannot read the parent row) and is
  -- deferred until there is a real second-endpoint requirement.
  multi_endpoint boolean NOT NULL DEFAULT false,

  status         text NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE','INACTIVE')),
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, code)
);

COMMENT ON COLUMN merchant_store.provider_id IS
  'providers.id — the party the UI calls "Merchant" (persona PROVIDER).';

CREATE INDEX IF NOT EXISTS merchant_store_provider_idx
  ON merchant_store (provider_id, status);

-- ── Store <-> QR allocation (BRD module 02) ──────────────────────────────────
-- Append-mostly: a switch DEACTIVATES the current row and INSERTS a new one rather than
-- updating in place, so the table is itself the allocation history the BRD asks to be
-- immutable. Nothing deletes from here.
CREATE TABLE IF NOT EXISTS merchant_store_qr_assignment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL DEFAULT 'tenant-default',
  store_id        uuid NOT NULL REFERENCES merchant_store(id) ON DELETE CASCADE,
  qr_id           uuid NOT NULL REFERENCES banker_qr(id),
  -- Denormalised owner AT THE TIME OF ASSIGNMENT. banker_qr.banker_code is immutable in
  -- practice, but reading history must not depend on that promise holding forever.
  banker_code     text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  assigned_by     text,
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  deactivated_by  text,
  deactivated_at  timestamptz,
  -- The switch event that ended this assignment, if a switch did.
  ended_by_switch uuid
);

-- One live endpoint per store. This is the constraint the whole feature rests on: without
-- it a half-failed switch leaves a store with two active QRs and no way to say which one is
-- real. See the phase-1 limitation note on merchant_store.multi_endpoint.
CREATE UNIQUE INDEX IF NOT EXISTS store_qr_one_active_uidx
  ON merchant_store_qr_assignment (store_id)
  WHERE is_active;

-- A QR serves at most one store at a time. Two stores on one endpoint makes per-store
-- attribution impossible for every credit that arrives on it.
CREATE UNIQUE INDEX IF NOT EXISTS store_qr_exclusive_uidx
  ON merchant_store_qr_assignment (qr_id)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS store_qr_history_idx
  ON merchant_store_qr_assignment (store_id, assigned_at DESC);

CREATE INDEX IF NOT EXISTS store_qr_banker_idx
  ON merchant_store_qr_assignment (banker_code, is_active);

-- ── Switch events (BRD modules 05 + 08) ──────────────────────────────────────
-- Immutable record of every endpoint change. Written inside the same transaction as the
-- assignment swap, so a switch that is visible in the assignment table is always visible
-- here too — there is no ordering in which one exists without the other.
CREATE TABLE IF NOT EXISTS qr_switch_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL DEFAULT 'tenant-default',
  store_id        uuid NOT NULL REFERENCES merchant_store(id) ON DELETE CASCADE,
  from_qr_id      uuid REFERENCES banker_qr(id),   -- NULL on first allocation
  to_qr_id        uuid NOT NULL REFERENCES banker_qr(id),
  banker_code     text NOT NULL,
  reason          text,
  actor           text NOT NULL,                   -- email / subject that clicked
  actor_role      text NOT NULL,                   -- MERCHANT (banker) | SUPER_ADMIN | ADMIN
  -- Idempotency (BRD module 08): a retried click, a double-submit or a replayed request must
  -- not produce a second switch. The caller sends a key; a repeat returns the original event.
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS qr_switch_idempotency_uidx
  ON qr_switch_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS qr_switch_store_idx
  ON qr_switch_events (store_id, created_at DESC);

CREATE INDEX IF NOT EXISTS qr_switch_banker_idx
  ON qr_switch_events (banker_code, created_at DESC);

-- ── QR lifecycle audit (BRD module 11) ───────────────────────────────────────
-- Approving, rejecting, pausing and resuming a QR are privileged acts with no merchant on
-- either side, so they cannot go in provider_audit_logs — its provider_id is NOT NULL, and
-- a best-effort insert there would simply never land. This is the QR-centric trail: one row
-- per privileged change, never updated, never deleted.
--
-- The switch itself is written to BOTH: here (so a QR's own history is complete) and to
-- provider_audit_logs (so the affected merchant's audit view shows it), because the two
-- questions "what happened to this QR" and "what happened to my stores" have different
-- readers.
CREATE TABLE IF NOT EXISTS qr_audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL DEFAULT 'tenant-default',
  qr_id       uuid REFERENCES banker_qr(id) ON DELETE SET NULL,
  banker_code text,
  action      text NOT NULL,          -- qr.created | qr.approve | qr.reject | qr.pause | ...
  actor       text NOT NULL,
  actor_role  text,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS qr_audit_qr_idx     ON qr_audit_logs (qr_id, created_at DESC);
CREATE INDEX IF NOT EXISTS qr_audit_banker_idx ON qr_audit_logs (banker_code, created_at DESC);
