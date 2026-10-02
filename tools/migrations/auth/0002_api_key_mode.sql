-- authservice_db: TEST / LIVE MODE on API keys.
--
-- A v2 request is authenticated by `Authorization: Bearer <api key>` and the key decides the
-- mode of the order, as the Key + Salt pair does on v1: sk_live_… is live, sk_test_… is test.
-- Keys issued before this are plain sk_… and are live, so NOT NULL DEFAULT true.
--
-- The lookup is by the SHA-256 of the presented key, on every v2 request: indexed.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS livemode boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS api_keys_secret_hash_idx ON api_keys (secret_hash);
