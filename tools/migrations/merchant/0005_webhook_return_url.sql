-- merchants: per-merchant default webhook (status-callback) + browser return URLs
-- for the hosted-checkout integration. Referenced by /api/merchants/[id] (profile
-- save), /api/me/integration, and the pay-in status callback. Idempotent.

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS webhook_url text;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS return_url  text;
