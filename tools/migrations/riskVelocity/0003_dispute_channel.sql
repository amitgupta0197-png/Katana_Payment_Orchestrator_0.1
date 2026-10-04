-- riskvelocityservice_db: a dispute keeps the pay-in channel of the transaction it is about.
-- Written when the dispute is opened (lib/disputes); NULL on disputes from before, which the
-- API reads as INTENT for a checkout order (a gateway takes every one of those) and otherwise
-- from the Katana Pay order it names.

DO $$ BEGIN
  IF to_regclass('disputes') IS NOT NULL THEN
    ALTER TABLE disputes ADD COLUMN IF NOT EXISTS channel_type text;
    BEGIN
      ALTER TABLE disputes ADD CONSTRAINT disputes_channel_chk
        CHECK (channel_type IS NULL OR channel_type IN ('INTENT','P2P','UNCLASSIFIED'));
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;
