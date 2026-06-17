-- riskvelocityservice_db: AML / sanctions / PEP / AML case workflow / risk scores.
-- BRD §9 (P5): "Sanctions screening, PEP screening, adverse media checks,
-- merchant risk scoring, payout beneficiary screening, transaction monitoring,
-- case workflow."

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Reference lists (small demo seed; production swaps to a vendor feed).
CREATE TABLE IF NOT EXISTS sanctions_list (
  list_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL,         -- OFAC | UN | EU | UK_HMT | FATF
  full_name    text NOT NULL,
  aliases      text[] NOT NULL DEFAULT '{}',
  date_of_birth date,
  country      text,
  identifier   text,                  -- passport / national-id reference if known
  reason       text,
  added_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sanctions_list_name_idx ON sanctions_list (lower(full_name));

CREATE TABLE IF NOT EXISTS pep_list (
  pep_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name    text NOT NULL,
  role         text NOT NULL,         -- "minister of finance" etc.
  country      text NOT NULL,
  tier         text NOT NULL DEFAULT 'HIGH',  -- HIGH | MEDIUM | LOW
  active_until date,
  added_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pep_list_name_idx ON pep_list (lower(full_name));

-- Every screening pass writes one row, even if no hit. We can replay.
CREATE TABLE IF NOT EXISTS screening_runs (
  run_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   text NOT NULL,        -- merchant | beneficiary | customer | director
  entity_id     text NOT NULL,
  full_name     text NOT NULL,
  country       text,
  dob           date,
  identifier    text,
  hits_count    integer NOT NULL DEFAULT 0,
  sanctions_hit boolean NOT NULL DEFAULT false,
  pep_hit       boolean NOT NULL DEFAULT false,
  triggered_case uuid,
  decision      text NOT NULL DEFAULT 'CLEAR',  -- CLEAR | REVIEW | BLOCK
  raw_hits      jsonb NOT NULL DEFAULT '[]'::jsonb,
  run_at        timestamptz NOT NULL DEFAULT now(),
  actor_id      text
);
CREATE INDEX IF NOT EXISTS screening_runs_entity_idx ON screening_runs (entity_type, entity_id, run_at DESC);
CREATE INDEX IF NOT EXISTS screening_runs_decision_idx ON screening_runs (decision, run_at DESC);

-- AML case workflow (BRD §9: "case workflow").
CREATE TABLE IF NOT EXISTS aml_cases (
  case_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL DEFAULT 'tenant-default',
  entity_type    text NOT NULL,
  entity_id      text NOT NULL,
  source         text NOT NULL,        -- sanctions | pep | velocity | manual | risk_score
  status         text NOT NULL DEFAULT 'OPEN',
    -- OPEN | UNDER_REVIEW | ESCALATED | CLOSED_CLEARED | CLOSED_BLOCKED
  severity       text NOT NULL DEFAULT 'MEDIUM',   -- LOW | MEDIUM | HIGH | CRITICAL
  summary        text NOT NULL,
  evidence       jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision_notes text,
  opened_at      timestamptz NOT NULL DEFAULT now(),
  opened_by      text,
  assigned_to    text,
  decided_at     timestamptz,
  decided_by     text,
  related_run    uuid
);
CREATE INDEX IF NOT EXISTS aml_cases_status_idx ON aml_cases (status, opened_at DESC);
CREATE INDEX IF NOT EXISTS aml_cases_entity_idx ON aml_cases (entity_type, entity_id, opened_at DESC);

-- Per-transaction risk score (BRD §9 risk_score formula).
CREATE TABLE IF NOT EXISTS risk_scores (
  score_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid,
  merchant_id   text NOT NULL,
  total_score   numeric(5,4) NOT NULL,    -- 0..1
  decision      text NOT NULL,            -- ALLOW | CHALLENGE | BLOCK
  components    jsonb NOT NULL,
  scored_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS risk_scores_order_idx ON risk_scores (order_id);
CREATE INDEX IF NOT EXISTS risk_scores_merchant_idx ON risk_scores (merchant_id, scored_at DESC);

-- SCA / 3DS2 policy table (BRD §7 P3 acceptance: exemption_reason recorded).
CREATE TABLE IF NOT EXISTS sca_policies (
  policy_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id          text,                 -- NULL = platform default
  country              text,                 -- NULL = applies to all
  method               text,                 -- NULL = applies to all (CARD typical)
  always_challenge     boolean NOT NULL DEFAULT false,
  challenge_above_minor bigint NOT NULL DEFAULT 3000_00,  -- INR 3,000 = ~€30 LVP
  trusted_beneficiary_threshold_minor bigint NOT NULL DEFAULT 0,
  risk_score_threshold numeric(5,4) NOT NULL DEFAULT 0.6,
  enabled              boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sca_policies_match_idx ON sca_policies (merchant_id, country, method, enabled);

-- Seed: platform-default SCA policy.
INSERT INTO sca_policies (merchant_id, country, method, challenge_above_minor, risk_score_threshold, enabled)
  VALUES (NULL, NULL, 'CARD', 300000, 0.60, true)
  ON CONFLICT DO NOTHING;

-- Seed: sanctions list (synthetic — none of these are real entities).
INSERT INTO sanctions_list (source, full_name, aliases, country, identifier, reason) VALUES
  ('OFAC',   'Ivan Petrov', '{"Petrov, Ivan"}', 'RU', 'PASS-RU-001', 'sectoral sanctions: synthetic test record'),
  ('UN',     'Acme Shell Holdings', '{"Acme Shell"}', 'PA', 'CO-PA-99', 'shell co. used in synthetic test'),
  ('OFAC',   'Kim Hwang', '{}', 'KP', 'PASS-KP-007', 'designated party (synthetic)'),
  ('EU',     'Maria Garcia', '{"M. Garcia"}', 'CU', 'PASS-CU-22', 'synthetic test entry')
  ON CONFLICT DO NOTHING;

-- Seed: PEP list.
INSERT INTO pep_list (full_name, role, country, tier) VALUES
  ('Elena Markovic', 'Minister of Finance (acting)',  'RS', 'HIGH'),
  ('Tunde Adewale',  'Central Bank Governor',         'NG', 'HIGH'),
  ('Priya Reddy',    'Member of Parliament',          'IN', 'MEDIUM'),
  ('Jorge Mendez',   'Mayor (Tier-1 city)',           'MX', 'MEDIUM')
  ON CONFLICT DO NOTHING;
