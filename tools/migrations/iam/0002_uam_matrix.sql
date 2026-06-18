-- iamservice_db: User Access Management matrix. Maps each platform module
-- to a per-persona CRUD bitmask. Super Admin can edit at runtime via
-- /admin/access; lib/access.ts consults this in middleware-free flows.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS uam_modules (
  module_code  text PRIMARY KEY,
  display_name text NOT NULL,
  area         text NOT NULL,            -- PaymentMgmt | Money | Risk | Operations | Admin
  description  text
);

CREATE TABLE IF NOT EXISTS uam_module_access (
  access_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_code  text NOT NULL REFERENCES uam_modules(module_code) ON DELETE CASCADE,
  persona      text NOT NULL,            -- SUPER_ADMIN | PROVIDER | MERCHANT
  can_create   boolean NOT NULL DEFAULT false,
  can_read     boolean NOT NULL DEFAULT true,
  can_update   boolean NOT NULL DEFAULT false,
  can_delete   boolean NOT NULL DEFAULT false,
  can_admin    boolean NOT NULL DEFAULT false,   -- kill-switch / reset / approve
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);
CREATE UNIQUE INDEX IF NOT EXISTS uam_module_access_uniq
  ON uam_module_access (module_code, persona);

-- Seed all modules.
INSERT INTO uam_modules (module_code, display_name, area, description) VALUES
  ('providers',    'Providers',       'PaymentMgmt', 'BRD §4 P0 provider management'),
  ('merchants',    'Merchants',       'PaymentMgmt', 'BRD §5 P1 merchant onboarding'),
  ('sub_mids',     'Sub-MIDs',        'PaymentMgmt', 'BRD §5 P1A sub-MID engine'),
  ('channels',     'Channels',        'PaymentMgmt', 'Rail / channel config'),
  ('checkout',     'Checkout/Orders', 'Money',       'BRD §7 P3 payment orders'),
  ('routing',      'Routing',         'Money',       'BRD §6 P2 routing engine'),
  ('settlement',   'Settlement',      'Money',       'BRD §10 P6 settlement batches'),
  ('reserves',     'Reserves',        'Money',       'BRD §12 P8 reserve engine'),
  ('ledger',       'Ledger',          'Money',       'BRD §10 P6 double-entry ledger'),
  ('refunds',      'Refunds',         'Money',       'BRD §7 refund lifecycle'),
  ('commission',   'Commission',      'Money',       'Commission accruals + payouts'),
  ('fund',         'Treasury / Fund', 'Money',       'Fund movements + bank balances'),
  ('payout',       'Payouts',         'Money',       'Outbound payouts'),
  ('disputes',     'Disputes',        'Risk',        'BRD §10 dispute lifecycle'),
  ('risk',         'Risk + AML',      'Risk',        'BRD §9 P5 risk scoring + chargebacks'),
  ('aml_cases',    'AML cases',       'Risk',        'BRD §9 case workflow'),
  ('sca',          'SCA policies',    'Risk',        'BRD §7 3DS2/SCA'),
  ('reconciliation','Reconciliation', 'Risk',        'BRD §11 P7 three-way recon'),
  ('kyb',          'KYB',             'Risk',        'KYB documents'),
  ('agents',       'AI Agents',       'Operations',  'BRD §14 P10 nine agents'),
  ('events',       'Event stream',    'Operations',  'BRD §16 event bus'),
  ('webhooks',     'Webhooks',        'Operations',  'Merchant webhook outbox'),
  ('reporting',    'Reporting',       'Operations',  'Financial + ops reports'),
  ('partner_data', 'Partner data',    'Operations',  'Partner settlement pull'),
  ('admin_log',    'Audit / WORM',    'Admin',       'WORM audit log'),
  ('users',        'Users',           'Admin',       'Platform users'),
  ('roles',        'Roles',           'Admin',       'Role definitions'),
  ('assignments',  'Assignments',     'Admin',       'User-role assignments'),
  ('access',       'Access matrix',   'Admin',       'UAM module × persona matrix'),
  ('api_keys',     'API keys',        'Admin',       'Issued API keys'),
  ('tenants',      'Tenants',         'Admin',       'Tenant management'),
  ('maker_checker','Maker-checker',   'Admin',       'Pending approvals'),
  ('tokens',       'Vault / tokens',  'Admin',       'BRD §15 vaults'),
  ('credentials',  'Credentials',     'Admin',       'Credential vault'),
  ('noc',          'NOC',             'Admin',       'SLOs + incidents'),
  ('hardening',    'Hardening',       'Admin',       'BRD §22 readiness')
ON CONFLICT (module_code) DO UPDATE SET display_name=EXCLUDED.display_name, area=EXCLUDED.area;

-- Seed access — SUPER_ADMIN gets everything; PROVIDER/MERCHANT get scoped reads.
INSERT INTO uam_module_access (module_code, persona, can_create, can_read, can_update, can_delete, can_admin)
SELECT m.module_code, 'SUPER_ADMIN', true, true, true, true, true FROM uam_modules m
ON CONFLICT (module_code, persona) DO NOTHING;

-- PROVIDER persona: own-merchants + own KYC + own commission read; no admin.
INSERT INTO uam_module_access (module_code, persona, can_create, can_read, can_update, can_delete, can_admin)
SELECT m.module_code, 'PROVIDER',
       CASE WHEN m.module_code IN ('merchants','sub_mids') THEN true ELSE false END,
       CASE WHEN m.module_code IN ('access','users','roles','assignments','tenants','admin_log','hardening','noc','credentials','events','agents','maker_checker','api_keys') THEN false ELSE true END,
       CASE WHEN m.module_code IN ('providers','merchants','sub_mids') THEN true ELSE false END,
       false, false
  FROM uam_modules m
ON CONFLICT (module_code, persona) DO NOTHING;

-- MERCHANT persona: own checkout / refunds / settlements / reserves / disputes only.
INSERT INTO uam_module_access (module_code, persona, can_create, can_read, can_update, can_delete, can_admin)
SELECT m.module_code, 'MERCHANT',
       CASE WHEN m.module_code IN ('checkout','refunds','tokens','api_keys') THEN true ELSE false END,
       CASE WHEN m.module_code IN ('checkout','settlement','reserves','refunds','disputes','tokens','api_keys','reporting','ledger') THEN true ELSE false END,
       CASE WHEN m.module_code IN ('api_keys','tokens') THEN true ELSE false END,
       false, false
  FROM uam_modules m
ON CONFLICT (module_code, persona) DO NOTHING;
