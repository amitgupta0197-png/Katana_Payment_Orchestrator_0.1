-- providerservice_db: a banker→merchant settlement request raised by the Settlement Engine names
-- its instruction (settlementservice_db.settlement_instructions.id). The engine follows the
-- request's status (the banker pays, the merchant verifies) instead of a second workflow. A request
-- with no instruction is one the merchant raised by hand, which ledger-sync posts when verified.
ALTER TABLE provider_branch_settlements ADD COLUMN IF NOT EXISTS instruction_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS provider_branch_settlements_instruction_uk
  ON provider_branch_settlements (instruction_id) WHERE instruction_id IS NOT NULL;

-- A request raised by hand (no instruction) goes on the ledger when the merchant verifies it, and
-- comes off again if it is later reversed (lib/ledger-sync). The stamps make each happen once.
ALTER TABLE provider_branch_settlements ADD COLUMN IF NOT EXISTS ledger_posted_at timestamptz;
ALTER TABLE provider_branch_settlements ADD COLUMN IF NOT EXISTS ledger_reversed_at timestamptz;
