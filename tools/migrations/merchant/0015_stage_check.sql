-- merchantservice_db: the banker stage check must allow every stage onboarding moves through.
--
-- 0001 creates `merchants` with BANK_VERIFY and CONFIG among its stages, but only when the
-- table does not exist yet. A database whose table came from an earlier schema kept the older
-- check without those two, and there a banker cannot be advanced past Screening: the update
-- fails on merchants_stage_check. Found by tests/e2e on 2026-10-03.
--
-- This puts the full list in place. It only widens what is allowed, so no existing row can
-- fail it, and running it on a database that already has the full list changes nothing.

ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_stage_check;
ALTER TABLE merchants ADD CONSTRAINT merchants_stage_check
  CHECK (stage IN ('APPLICATION','DOCS_PENDING','SCREENING','BANK_VERIFY','CONFIG','IN_REVIEW','APPROVED','LIVE','SUSPENDED','TERMINATED','REJECTED'));
