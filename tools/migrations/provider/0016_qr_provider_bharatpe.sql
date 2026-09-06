-- Admit BharatPe to the QR provider list (2026-09-06).
--
-- BharatPe was onboarded as a collection rail in Sep 2026 — it is already captured on the
-- email channel (apps/admin-dashboard/src/lib/email-ingest.ts, parseBharatPeEmail). What it
-- could not be was a QR: `banker_qr.provider` is a CHECK-constrained enum written in
-- 0015_qr_switch_model.sql, so a banker uploading a BharatPe QR got a constraint violation
-- from the database rather than a row. The application-side list
-- (lib/qr-switch.ts QR_PROVIDERS, and the two "use client" pages that must duplicate it
-- because lib/qr-switch.ts imports pg) is widened in the same commit; this file is the half
-- that has to happen in the database, and the app half is inert without it.
--
-- IDEMPOTENT and REVERSIBLE. DROP ... IF EXISTS before ADD, so re-running is a no-op rather
-- than a duplicate-constraint error; the whole thing is skipped when banker_qr is absent
-- (an environment that has not yet run 0015). No row is read or rewritten — widening an
-- enum cannot invalidate data that already satisfies the narrower one.
--
-- To reverse: re-add the constraint without 'BHARATPE'. That will FAIL if a BharatPe QR has
-- been uploaded in the meantime, which is the correct outcome — the rows must go first.

DO $$
BEGIN
  IF to_regclass('public.banker_qr') IS NULL THEN
    RAISE NOTICE 'banker_qr absent — run 0015_qr_switch_model.sql first; skipping.';
    RETURN;
  END IF;

  ALTER TABLE banker_qr DROP CONSTRAINT IF EXISTS banker_qr_provider_check;
  ALTER TABLE banker_qr ADD  CONSTRAINT banker_qr_provider_check
    CHECK (provider IN ('GOOGLE_PAY','PHONEPE','PAYTM','MOBIKWIK','BHARATPE','OTHER'));

  RAISE NOTICE 'banker_qr.provider now admits BHARATPE.';
END $$;
