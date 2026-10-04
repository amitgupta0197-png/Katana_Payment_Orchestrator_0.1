-- vendorgatewayservice_db: the gateway go-live checklist is per ACCOUNT, not per gateway.
--
-- Since the MID switch (0040) a banker can hold more than one account on the same gateway (two
-- PayU accounts). With the checklist keyed by (banker, gateway), a second PayU account shared the
-- first one's LIVE row and took full live payments without ever being verified.
--
-- `account` is the account's credential-vault label (lib/gateway-creds): 'gateway_mid' for a
-- banker's first account, 'gateway_mid:<id>' for the others. Every row from before is the first
-- account, which is what it always described. Re-runnable.

ALTER TABLE gateway_golive ADD COLUMN IF NOT EXISTS account text NOT NULL DEFAULT 'gateway_mid';

DO $$
DECLARE pk_cols text;
BEGIN
  SELECT string_agg(a.attname, ',' ORDER BY a.attnum) INTO pk_cols
    FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
   WHERE i.indrelid = 'gateway_golive'::regclass AND i.indisprimary;
  IF pk_cols IS DISTINCT FROM 'merchant_id,gateway,account' THEN
    ALTER TABLE gateway_golive DROP CONSTRAINT IF EXISTS gateway_golive_pkey;
    ALTER TABLE gateway_golive ADD CONSTRAINT gateway_golive_pkey PRIMARY KEY (merchant_id, gateway, account);
  END IF;
END $$;
