-- merchantservice_db: a per-merchant TSP webhook link, generated at onboarding.
--
-- Every merchant gets ONE inbound callback URL on the Katana domain that their payment
-- gateway / TSP posts payment results to:
--     https://katanapay.co/api/v1/katana-pay/callback/<webhook_slug>
-- The slug is derived from the merchant's website (https://www.shopiva.com -> shopiva-com),
-- falling back to the merchant code. It is STORED, never recomputed: a link already handed
-- to a TSP must keep working even if the website on file changes later.
--
-- The signing secret for the link is sealed in credential_vault (checkoutservice_db,
-- kind=webhook_secret, owner=merchant, label=tsp_callback_secret) — not here.
--
-- Slug rules (mirrored in apps/admin-dashboard/src/lib/merchant-webhook.ts):
--   host  = website without scheme, credentials, port, path, and a leading "www."
--   base  = host with every run of non [a-z0-9] replaced by "-", trimmed, max 60 chars
--   slug  = base, or the merchant code when there is no website
--   taken -> base-<code>, then -<4 hex of the merchant id>
-- Production data has shared placeholder websites (several merchants on www.google.com),
-- so the collision path is exercised by the backfill, oldest merchant first.

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS webhook_slug text;

CREATE UNIQUE INDEX IF NOT EXISTS merchants_webhook_slug_uk
  ON merchants (webhook_slug) WHERE webhook_slug IS NOT NULL;

DO $$
DECLARE
  r     record;
  host  text;
  base  text;
  code  text;
  cand  text;
BEGIN
  FOR r IN SELECT id, merchant_code, website FROM merchants
            WHERE webhook_slug IS NULL ORDER BY created_at, merchant_code LOOP
    host := lower(trim(coalesce(r.website, '')));
    host := regexp_replace(host, '^[a-z][a-z0-9+.-]*://', '');
    host := split_part(split_part(split_part(host, '/', 1), '?', 1), '#', 1);
    host := regexp_replace(host, '^.*@', '');
    host := split_part(host, ':', 1);
    host := regexp_replace(host, '^www\.', '');
    base := trim(both '-' from left(trim(both '-' from regexp_replace(host, '[^a-z0-9]+', '-', 'g')), 60));
    code := trim(both '-' from regexp_replace(lower(r.merchant_code), '[^a-z0-9]+', '-', 'g'));

    cand := CASE WHEN base <> '' THEN base ELSE code END;
    IF EXISTS (SELECT 1 FROM merchants WHERE webhook_slug = cand) AND base <> '' THEN
      cand := base || '-' || code;
    END IF;
    IF EXISTS (SELECT 1 FROM merchants WHERE webhook_slug = cand) THEN
      cand := cand || '-' || substr(md5(r.id::text), 1, 4);
    END IF;

    UPDATE merchants SET webhook_slug = cand WHERE id = r.id;
  END LOOP;
END $$;
