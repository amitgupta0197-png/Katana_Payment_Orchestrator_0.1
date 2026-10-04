-- routingengineservice_db: custom field values for the CHANNEL master (rails rows), governed by
-- the MDM template in merchantservice_db (merchant 0022, lib/mdm.ts). Additive, idempotent.
ALTER TABLE rails ADD COLUMN IF NOT EXISTS extra jsonb NOT NULL DEFAULT '{}'::jsonb;
