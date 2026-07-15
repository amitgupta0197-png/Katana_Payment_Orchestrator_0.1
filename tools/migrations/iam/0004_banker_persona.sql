-- iamservice_db: add the BANKER persona for the DT Business Model separate login
-- (BRD §8/§10). A BANKER grant is scoped to the banker_id used across the DT
-- tables (dt_purchases.banker_id etc.) and lands in /banker-portal.

ALTER TABLE user_personas DROP CONSTRAINT IF EXISTS user_personas_persona_kind_check;
ALTER TABLE user_personas ADD CONSTRAINT user_personas_persona_kind_check
  CHECK (persona_kind IN ('SUPER_ADMIN','ADMIN','PROVIDER','MERCHANT','BANKER','OPERATOR','COMPLIANCE','FINANCE','RISK','SUPPORT'));
