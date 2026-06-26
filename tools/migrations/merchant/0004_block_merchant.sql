-- merchantservice_db: block a merchant from creating new pay-ins (risk/ops action).
ALTER TABLE merchant_payment_config ADD COLUMN IF NOT EXISTS blocked boolean NOT NULL DEFAULT false;
