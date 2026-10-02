-- vendorgatewayservice_db: each capture phone signs with its own key.
--
-- Every agent phone used to sign its requests with one secret compiled into the APK, and the
-- APK is a public download: whoever unpacked it could sign as any phone, a TRUSTED one
-- included. From agent v3.11 a phone makes its own key pair (in the Android Keystore where the
-- phone has one), keeps the private half and enrols the public half here. A request signed
-- with that key can only have come from that phone.
--
-- One row per device id. The first key a device id presents is kept (when the device is
-- already known, only if the request also carries its install id, which is never shown or
-- typed). A different key for the same device id is refused until staff reset it: that is
-- either a reinstall, or someone else claiming to be the phone.

CREATE TABLE IF NOT EXISTS vendor_device_keys (
  device_id        text PRIMARY KEY,
  public_key       text NOT NULL,              -- base64 of the X.509 SubjectPublicKeyInfo (EC P-256)
  install_id       text,
  hardware_backed  boolean,                    -- as the phone reported it: the key is in the Keystore
  enrolled_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz
);
