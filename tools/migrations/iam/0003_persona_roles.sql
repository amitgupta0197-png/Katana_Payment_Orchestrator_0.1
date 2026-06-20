-- iamservice_db: widen persona roles for the FIFO Payment Operations module
-- (BRD §8). Adds OPERATOR, ADMIN, COMPLIANCE, FINANCE, RISK, SUPPORT alongside
-- the original SUPER_ADMIN / PROVIDER / MERCHANT.

ALTER TABLE user_personas DROP CONSTRAINT IF EXISTS user_personas_persona_kind_check;
ALTER TABLE user_personas ADD CONSTRAINT user_personas_persona_kind_check
  CHECK (persona_kind IN ('SUPER_ADMIN','ADMIN','PROVIDER','MERCHANT','OPERATOR','COMPLIANCE','FINANCE','RISK','SUPPORT'));
