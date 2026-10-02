-- auditservice_db: API REQUEST LOG — one row per request a merchant's server made to the
-- order APIs (v2, and the v1 Key + Salt order endpoints).
--
-- A merchant sees a summary of its own rows for the last 7 days (time, endpoint, status,
-- latency). Staff see the bodies too. The bodies are stored already redacted: no Authorization
-- header is kept, and `hash` / `key` values are cut to a hint (lib/api-log).
--
-- Written best-effort after the response is decided; a row that cannot be written never
-- changes the answer the merchant gets. Rows older than 90 days are removed by the daily job.

CREATE TABLE IF NOT EXISTS api_request_log (
  id            bigserial PRIMARY KEY,
  request_id    text NOT NULL,
  merchant_id   text,                    -- the banker code the key belongs to; NULL when the key was not recognised
  livemode      boolean,
  api_version   text NOT NULL,           -- v1 | v2
  method        text NOT NULL,
  endpoint      text NOT NULL,           -- the route, not the full URL: /v2/orders, /v2/orders/{id}
  http_status   integer NOT NULL,
  latency_ms    integer NOT NULL,
  error_code    text,
  request_body  jsonb,
  response_body jsonb,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_request_log_merchant_idx ON api_request_log (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_request_log_created_idx  ON api_request_log (created_at DESC);
