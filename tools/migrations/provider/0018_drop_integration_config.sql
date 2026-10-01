-- providerservice_db: the upstream integration config table is retired.
--
-- provider_integration_config (0003) held a per-merchant base URL, Pay ID and secret flags
-- for an upstream gateway integration that was never switched on. The code that read it is
-- gone. The table is dropped only when it is empty, so nothing configured is ever lost.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'provider_integration_config') THEN
    IF NOT EXISTS (SELECT 1 FROM provider_integration_config) THEN
      DROP TABLE provider_integration_config;
    ELSE
      RAISE NOTICE 'provider_integration_config is not empty; left in place';
    END IF;
  END IF;
END $$;
