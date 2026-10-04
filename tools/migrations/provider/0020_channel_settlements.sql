-- providerservice_db: SETTLEMENT AND FEE CHANNEL LINEAGE.
--
-- provider_branch_settlements.channel_type: which pay-in channel a banker's settlement covers.
-- A settlement for INTENT is applied only to the banker's INTENT pay-ins and one for P2P only to
-- its P2P pay-ins (lib/banker-settled). NULL is every settlement from before, and one raised for
-- both channels: it is applied to whatever is still unsettled after the channel settlements,
-- oldest first, so each order it covers is still settled in that order's own channel.
--
-- provider_settlement_rules.channel_type: a fee rate for one channel. NULL = both. A channel's
-- own rate wins over a rate for both at the same scope (lib/channel-fees).

-- Each table is altered only where it exists (the rate card arrived with provider 0006).
DO $$ BEGIN
  IF to_regclass('provider_branch_settlements') IS NOT NULL THEN
    ALTER TABLE provider_branch_settlements ADD COLUMN IF NOT EXISTS channel_type text;
    BEGIN
      ALTER TABLE provider_branch_settlements ADD CONSTRAINT provider_branch_settlements_channel_chk
        CHECK (channel_type IS NULL OR channel_type IN ('INTENT','P2P'));
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
  IF to_regclass('provider_settlement_rules') IS NOT NULL THEN
    ALTER TABLE provider_settlement_rules ADD COLUMN IF NOT EXISTS channel_type text;
    BEGIN
      ALTER TABLE provider_settlement_rules ADD CONSTRAINT provider_settlement_rules_channel_chk
        CHECK (channel_type IS NULL OR channel_type IN ('INTENT','P2P'));
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;
