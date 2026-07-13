-- merchantservice_db: inbound partner / contact-us enquiries from the public Katana Pay
-- landing site ("Become a Katana Partner" form). Captured by the public endpoint
-- POST /api/v1/partner-inquiry and surfaced to admins at /partner-inquiries.
CREATE TABLE IF NOT EXISTS partner_inquiries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  email        text NOT NULL,
  phone        text,
  company      text,
  partner_type text,                                  -- which audience they picked (referral, tech, bank…)
  message      text,
  status       text NOT NULL DEFAULT 'NEW'
               CHECK (status IN ('NEW','CONTACTED','CLOSED')),
  source       text NOT NULL DEFAULT 'landing',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_inquiries_status_idx ON partner_inquiries (status, created_at DESC);
