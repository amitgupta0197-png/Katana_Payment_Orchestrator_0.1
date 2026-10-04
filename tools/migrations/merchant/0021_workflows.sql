-- merchantservice_db: workflows — a TRACKING and ORCHESTRATION layer over the state machines that
-- already exist (lib/workflow.ts pure rules, lib/workflow-store.ts storage and sync).
--
-- Nothing here replaces or moves a real state. A banker's stage stays in merchants.stage and is
-- still moved by /api/merchants/{id}/advance with its gates; a TSP's in tsps.stage; MIDs in
-- issued_mids; approvals in maker_checker_requests (providerservice_db). A workflow instance
-- mirrors one actor's journey: its SYSTEM_CHECK steps complete when the real state shows them
-- done, its MAKER_CHECKER steps when the linked request is APPROVED, and its MANUAL_REVIEW /
-- DOCUMENT_UPLOAD steps when a person in the step's role ticks every checklist item.
--
-- Additive and idempotent: three new tables and the six pre-built templates. With the tables
-- empty nothing behaves differently anywhere.

-- 1. Templates. A change is a NEW version (approved through Maker-Checker,
--    `workflow.template_update`); instances keep the version they started on.
CREATE TABLE IF NOT EXISTS workflow_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  name           text NOT NULL,
  description    text,
  actor_type     text NOT NULL CHECK (actor_type IN ('TSP','BANKER','MERCHANT','MID','BANKER_SUSPENSION')),
  trigger_event  text,
  steps          jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
  version        integer NOT NULL CHECK (version > 0),
  active         boolean NOT NULL DEFAULT true,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_templates_key_version_uk UNIQUE (key, version)
);
-- One active version per template.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_templates_active_uk ON workflow_templates (key) WHERE active;

-- 2. Instances: one actor's journey through one template version.
CREATE TABLE IF NOT EXISTS workflow_instances (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       uuid NOT NULL REFERENCES workflow_templates(id),
  template_key      text NOT NULL,
  template_version  integer NOT NULL,
  actor_type        text NOT NULL CHECK (actor_type IN ('TSP','BANKER','MERCHANT','MID','BANKER_SUSPENSION')),
  actor_id          text NOT NULL,
  actor_label       text,
  actor_link        text,             -- the staff page of the actor (/bankers/{id}, /tsps/{id}, /merchants/{id})
  current_step_id   text,
  status            text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','PAUSED','COMPLETED','REJECTED')),
  initiated_by      text NOT NULL,
  initiated_at      timestamptz NOT NULL DEFAULT now(),
  step_started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  sla_due_at        timestamptz,      -- when the current step's timeout runs out; NULL = no timeout
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- One open instance per actor and template.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_instances_open_uk
  ON workflow_instances (template_key, actor_type, actor_id) WHERE status IN ('IN_PROGRESS','PAUSED');
CREATE INDEX IF NOT EXISTS workflow_instances_actor_idx ON workflow_instances (actor_type, actor_id);
CREATE INDEX IF NOT EXISTS workflow_instances_status_idx ON workflow_instances (status, initiated_at DESC);

-- 3. Everything that happened to a step. Append-only (trigger below).
CREATE TABLE IF NOT EXISTS workflow_step_events (
  id            bigserial PRIMARY KEY,
  instance_id   uuid NOT NULL,
  step_id       text NOT NULL,
  event         text NOT NULL CHECK (event IN ('STARTED','CHECKED','COMPLETED','FAILED','ESCALATED','REJECTED','COMMENT')),
  actor         text NOT NULL,
  method        text CHECK (method IN ('MANUAL','SYSTEM_AUTO','MAKER_CHECKER')),
  checklist     jsonb,
  comment       text,
  evidence_ref  text,             -- a Maker-Checker request id, a document reference, an alert key
  at            timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS workflow_step_events_instance_idx ON workflow_step_events (instance_id, id);

-- Append-only. Local test cleanup may delete with `SET LOCAL workflow.maintenance = 'on'`.
CREATE OR REPLACE FUNCTION workflow_events_locked() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('workflow.maintenance', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'workflow_step_events is append-only';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS workflow_step_events_locked_trg ON workflow_step_events;
CREATE TRIGGER workflow_step_events_locked_trg BEFORE UPDATE OR DELETE ON workflow_step_events
  FOR EACH ROW EXECUTE FUNCTION workflow_events_locked();

-- 4. The six pre-built templates (version 1). A step:
--    { step_id, name, step_type, assigned_role, checklist_items[{key,label}], timeout_hours,
--      on_pass, on_fail, system_check?, mc_action?, distinct_from?, loop? }
--    on_pass / on_fail: a step_id, or COMPLETE / REJECT. Missing on_pass = the next step.

INSERT INTO workflow_templates (key, name, description, actor_type, trigger_event, steps, version, active, created_by) VALUES
('tsp_onboarding', 'TSP Onboarding',
 'A TSP from application to live. Each stage is moved on the TSP page; going live is approved by a second person.',
 'TSP', 'tsp.created', $j$[
  {"step_id":"application","name":"Application","step_type":"SYSTEM_CHECK","assigned_role":"ADMIN","checklist_items":[],"timeout_hours":72,"system_check":"tsp.stage>=KYB_PENDING"},
  {"step_id":"kyb","name":"KYB documents approved","step_type":"DOCUMENT_UPLOAD","assigned_role":"COMPLIANCE","checklist_items":[{"key":"incorporation","label":"Certificate of incorporation approved"},{"key":"licence","label":"RBI licence approved (not needed for a bank arm)"}],"timeout_hours":120,"system_check":"tsp.stage>=SCREENING"},
  {"step_id":"screening","name":"Sanctions screening","step_type":"SYSTEM_CHECK","assigned_role":"COMPLIANCE","checklist_items":[],"timeout_hours":48,"system_check":"tsp.stage>=BANK_VERIFY"},
  {"step_id":"bank_verify","name":"Bank confirms the TSP","step_type":"SYSTEM_CHECK","assigned_role":"OPERATOR","checklist_items":[],"timeout_hours":120,"system_check":"tsp.stage>=CONFIG"},
  {"step_id":"go_live","name":"Go-live approval (Maker-Checker)","step_type":"MAKER_CHECKER","assigned_role":"SUPER_ADMIN","checklist_items":[],"timeout_hours":48,"mc_action":"tsp.go_live","system_check":"tsp.stage=LIVE","on_fail":"go_live","loop":true},
  {"step_id":"notify","name":"Tell operations","step_type":"NOTIFICATION","assigned_role":"OPERATOR","checklist_items":[],"timeout_hours":null}
 ]$j$::jsonb, 1, true, 'system'),
('banker_onboarding', 'Banker Onboarding with MID Issuance',
 'A banker from application to live, including the MIDs its bank issued through its TSP. Stages are still moved on the banker page.',
 'BANKER', 'banker.created', $j$[
  {"step_id":"application","name":"Application","step_type":"SYSTEM_CHECK","assigned_role":"OPERATOR","checklist_items":[],"timeout_hours":72,"system_check":"banker.stage>=DOCS_PENDING"},
  {"step_id":"kyb_docs","name":"KYB documents","step_type":"DOCUMENT_UPLOAD","assigned_role":"COMPLIANCE","checklist_items":[{"key":"docs","label":"KYB documents uploaded and reviewed"}],"timeout_hours":120,"system_check":"banker.stage>=SCREENING"},
  {"step_id":"screening","name":"Screening","step_type":"SYSTEM_CHECK","assigned_role":"COMPLIANCE","checklist_items":[],"timeout_hours":48,"system_check":"banker.stage>=BANK_VERIFY"},
  {"step_id":"bank_verify","name":"Bank verification","step_type":"SYSTEM_CHECK","assigned_role":"OPERATOR","checklist_items":[],"timeout_hours":72,"system_check":"banker.stage>=MID_ISSUANCE"},
  {"step_id":"mid_issuance","name":"MID issuance","step_type":"SYSTEM_CHECK","assigned_role":"ADMIN","checklist_items":[],"timeout_hours":120,"system_check":"banker.stage>=CONFIG"},
  {"step_id":"config","name":"Configuration","step_type":"SYSTEM_CHECK","assigned_role":"OPERATOR","checklist_items":[],"timeout_hours":72,"system_check":"banker.step_config"},
  {"step_id":"approval","name":"Go-live approval","step_type":"SYSTEM_CHECK","assigned_role":"SUPER_ADMIN","checklist_items":[],"timeout_hours":48,"system_check":"banker.stage>=LIVE"},
  {"step_id":"notify","name":"Tell operations","step_type":"NOTIFICATION","assigned_role":"OPERATOR","checklist_items":[],"timeout_hours":null}
 ]$j$::jsonb, 1, true, 'system'),
('merchant_onboarding', 'Merchant Onboarding',
 'A merchant from KYC to its first live banker.',
 'MERCHANT', 'merchant.created', $j$[
  {"step_id":"kyc","name":"KYC approved","step_type":"SYSTEM_CHECK","assigned_role":"COMPLIANCE","checklist_items":[],"timeout_hours":120,"system_check":"merchant.kyc_approved"},
  {"step_id":"banker","name":"Banker assigned","step_type":"SYSTEM_CHECK","assigned_role":"OPERATOR","checklist_items":[],"timeout_hours":72,"system_check":"merchant.has_banker"},
  {"step_id":"key","name":"Key generated","step_type":"SYSTEM_CHECK","assigned_role":"OPERATOR","checklist_items":[],"timeout_hours":48,"system_check":"merchant.key_generated"},
  {"step_id":"callback","name":"Callback URL set","step_type":"SYSTEM_CHECK","assigned_role":"SUPPORT","checklist_items":[],"timeout_hours":72,"system_check":"merchant.callback_set"},
  {"step_id":"integration_test","name":"Integration test passed","step_type":"SYSTEM_CHECK","assigned_role":"SUPPORT","checklist_items":[],"timeout_hours":120,"system_check":"merchant.test_payment"},
  {"step_id":"go_live","name":"Go-live","step_type":"SYSTEM_CHECK","assigned_role":"SUPER_ADMIN","checklist_items":[],"timeout_hours":72,"system_check":"merchant.live"},
  {"step_id":"notify","name":"Tell operations","step_type":"NOTIFICATION","assigned_role":"OPERATOR","checklist_items":[],"timeout_hours":null}
 ]$j$::jsonb, 1, true, 'system'),
('mid_issuance', 'MID Issuance',
 'One MID a bank issued to a banker: entered by one person, approved by another, then active.',
 'MID', 'mid.requested', $j$[
  {"step_id":"request","name":"Request","step_type":"SYSTEM_CHECK","assigned_role":"ADMIN","checklist_items":[],"timeout_hours":24,"system_check":"mid.recorded"},
  {"step_id":"bank_confirmation","name":"Bank confirmation","step_type":"MANUAL_REVIEW","assigned_role":"OPERATOR","checklist_items":[{"key":"letter","label":"The bank's issuance letter or mail is on file"},{"key":"value","label":"The MID number matches the bank's letter"}],"timeout_hours":72,"system_check":"mid.status=ACTIVE"},
  {"step_id":"maker_entry","name":"Maker entry","step_type":"SYSTEM_CHECK","assigned_role":"ADMIN","checklist_items":[],"timeout_hours":24,"system_check":"mid.request_raised"},
  {"step_id":"checker_approval","name":"Checker approval","step_type":"MAKER_CHECKER","assigned_role":"SUPER_ADMIN","checklist_items":[],"timeout_hours":48,"mc_action":"mid.issue","system_check":"mid.status=ACTIVE","on_fail":"REJECT"},
  {"step_id":"activation","name":"Activation","step_type":"SYSTEM_CHECK","assigned_role":"ADMIN","checklist_items":[],"timeout_hours":24,"system_check":"mid.status=ACTIVE"}
 ]$j$::jsonb, 1, true, 'system'),
('key_rotation', 'Key + Salt rotation',
 'Rotating a banker''s Key + Salt (the existing single pair). The rotation itself is done on the banker page''s Developer tab.',
 'BANKER', 'manual', $j$[
  {"step_id":"request","name":"Request","step_type":"MANUAL_REVIEW","assigned_role":"SUPPORT","checklist_items":[{"key":"reason","label":"Why the pair is rotated is written in a comment"},{"key":"banker_told","label":"The banker knows its server must take the new Salt"}],"timeout_hours":24},
  {"step_id":"maker_rotate","name":"Maker rotates","step_type":"MANUAL_REVIEW","assigned_role":"ADMIN","checklist_items":[{"key":"generated","label":"New live pair generated on the Developer tab"},{"key":"handed_over","label":"New Key + Salt handed to the banker over a safe channel"}],"timeout_hours":24},
  {"step_id":"checker_approve","name":"Checker approves","step_type":"MANUAL_REVIEW","assigned_role":"SUPER_ADMIN","checklist_items":[{"key":"verified","label":"The banker's first order with the new Key was accepted"}],"timeout_hours":48,"distinct_from":"maker_rotate","on_fail":"maker_rotate","loop":true},
  {"step_id":"old_key_retired","name":"Old key retired","step_type":"SYSTEM_CHECK","assigned_role":"ADMIN","checklist_items":[],"timeout_hours":24,"system_check":"banker.key_rotated"}
 ]$j$::jsonb, 1, true, 'system'),
('banker_suspension', 'Banker Suspension',
 'Suspending a banker: why, what it affects, then two people. The suspension itself is done on the banker page.',
 'BANKER_SUSPENSION', 'manual', $j$[
  {"step_id":"trigger","name":"Trigger","step_type":"MANUAL_REVIEW","assigned_role":"RISK","checklist_items":[{"key":"reason","label":"The reason is written in a comment, with evidence"}],"timeout_hours":12},
  {"step_id":"impact","name":"Impact assessment","step_type":"MANUAL_REVIEW","assigned_role":"RISK","checklist_items":[{"key":"open_orders","label":"Open pay-in orders reviewed"},{"key":"settlements","label":"Unsettled money and pending settlements reviewed"},{"key":"merchant","label":"The merchant's other bankers can take its traffic"}],"timeout_hours":24},
  {"step_id":"maker","name":"Maker","step_type":"MANUAL_REVIEW","assigned_role":"ADMIN","checklist_items":[{"key":"proposed","label":"Suspension proposed, with its effective time"}],"timeout_hours":12},
  {"step_id":"checker","name":"Checker","step_type":"MANUAL_REVIEW","assigned_role":"SUPER_ADMIN","checklist_items":[{"key":"agreed","label":"Reason and impact agreed"}],"timeout_hours":12,"distinct_from":"maker","on_fail":"REJECT"},
  {"step_id":"suspend","name":"Suspend","step_type":"SYSTEM_CHECK","assigned_role":"SUPER_ADMIN","checklist_items":[],"timeout_hours":6,"system_check":"banker.stage=SUSPENDED"},
  {"step_id":"notify","name":"Tell operations","step_type":"NOTIFICATION","assigned_role":"OPERATOR","checklist_items":[],"timeout_hours":null}
 ]$j$::jsonb, 1, true, 'system')
ON CONFLICT (key, version) DO NOTHING;
