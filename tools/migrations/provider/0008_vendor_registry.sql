-- Vendor registry (BRD §3): the upline's list of vendors/beneficiaries that settlements
-- pay out to — full KYC-ish detail (PAN/GST, category, docs) and a lifecycle status.
-- Vendors belong to the provider that created them; the downline only ever sees the
-- vendor SNAPSHOT carried on a settlement addressed to it (no vendor-list API for
-- branches), which is the BRD's visibility rule.

CREATE TABLE IF NOT EXISTS provider_vendors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  vendor_name     text NOT NULL,               -- trading/display name
  beneficiary_name text NOT NULL,              -- name on the bank account
  account_number  text,
  ifsc            text,
  bank_name       text,
  bank_branch     text,
  account_type    text CHECK (account_type IN ('SAVINGS','CURRENT') OR account_type IS NULL),
  vpa             text,                        -- UPI VPA (alternative rail)
  mobile_number   text,
  pan             text,
  gstin           text,
  settlement_ref  text,                        -- upline's own reference for this vendor
  category        text,                        -- e.g. SUPPLIER / LOGISTICS / MARKETING
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','UNDER_REVIEW')),
  notes           text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pv_provider ON provider_vendors (provider_id, status);

-- Supporting documents (agreement, cancelled cheque, GST cert…): same hardened pattern
-- as provider KYC docs — content stored outside the web root, sha256-deduped.
CREATE TABLE IF NOT EXISTS provider_vendor_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id   uuid NOT NULL REFERENCES provider_vendors(id) ON DELETE CASCADE,
  doc_type    text NOT NULL,
  uri         text NOT NULL,
  sha256      text NOT NULL,
  uploaded_by text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_pvd_vendor ON provider_vendor_documents (vendor_id);

-- Settlements can now target a VENDOR (the BRD's model: the downline pays the upline's
-- vendor directly). beneficiary_id (the provider's own accounts) stays for back-compat;
-- the vendor's bank details are snapshotted into beneficiary_snapshot at raise time.
ALTER TABLE provider_branch_settlements
  ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES provider_vendors(id);
