// Partner API keys (vendorGateway 0044 partner_api_keys): pk_live_… creates live orders, pk_test_…
// test orders. Only the SHA-256 is kept, so a key is shown once, when it is made. Separate from the
// v2 banker keys (lib/v2-keys): a partner key names no banker and opens only /api/v1/partner/*.

import { createHash, randomBytes } from "crypto";
import { rows } from "@/lib/pg";
import { partnerKeyMode } from "@/lib/partner/rules";
import { getPartner, logPartnerEvent, type PartnerRow } from "@/lib/partner/store";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface PartnerKeyRow { id: string; label: string; prefix: string; livemode: boolean; status: string; issued_by: string; created_at: string; last_used_at: string | null; revoked_at: string | null }

export interface PartnerKeyOwner { partner: PartnerRow; livemode: boolean; keyId: string }

/** The partner and mode behind a presented key, or null. Database errors propagate. */
export async function resolvePartnerKey(key: string): Promise<PartnerKeyOwner | null> {
  const mode = partnerKeyMode(key);
  if (mode === null) return null;
  const r = await rows<{ id: string; partner_id: string; livemode: boolean }>("vendorGateway", `
    SELECT id::text, partner_id::text, livemode FROM partner_api_keys WHERE secret_hash = $1 AND status = 'ACTIVE' LIMIT 1
  `, [sha256(key)]);
  const k = r[0];
  // The stored mode and the prefix must agree.
  if (!k || k.livemode !== mode) return null;
  const partner = await getPartner(k.partner_id);
  if (!partner) return null;
  void rows("vendorGateway",
    `UPDATE partner_api_keys SET last_used_at = now() WHERE id = $1::uuid AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [k.id]).catch(() => {});
  return { partner, livemode: mode, keyId: k.id };
}

export async function listPartnerKeys(partnerId: string): Promise<PartnerKeyRow[]> {
  return rows<PartnerKeyRow>("vendorGateway", `
    SELECT id::text, label, prefix, livemode, status, issued_by, created_at, last_used_at, revoked_at
      FROM partner_api_keys WHERE partner_id = $1::uuid ORDER BY created_at DESC LIMIT 100
  `, [partnerId]);
}

export async function issuePartnerKey(partnerId: string, livemode: boolean, label: string, by: string): Promise<{ key: PartnerKeyRow; secret: string }> {
  const secret = `${livemode ? "pk_live_" : "pk_test_"}${randomBytes(24).toString("base64url")}`;
  const r = await rows<PartnerKeyRow>("vendorGateway", `
    INSERT INTO partner_api_keys (partner_id, label, prefix, secret_hash, livemode, issued_by)
    VALUES ($1::uuid, $2, $3, $4, $5, $6)
    RETURNING id::text, label, prefix, livemode, status, issued_by, created_at, last_used_at, revoked_at
  `, [partnerId, label.trim().slice(0, 120) || (livemode ? "Live key" : "Test key"), secret.slice(0, 12), sha256(secret), livemode, by]);
  await logPartnerEvent(partnerId, "KEY_ISSUED", by, { key_id: r[0].id, prefix: r[0].prefix, livemode });
  return { key: r[0], secret };
}

export async function revokePartnerKey(partnerId: string, keyId: string, by: string): Promise<boolean> {
  const r = await rows<{ prefix: string }>("vendorGateway", `
    UPDATE partner_api_keys SET status = 'REVOKED', revoked_at = now()
     WHERE id = $1::uuid AND partner_id = $2::uuid AND status = 'ACTIVE' RETURNING prefix
  `, [keyId, partnerId]);
  if (r.length) await logPartnerEvent(partnerId, "KEY_REVOKED", by, { key_id: keyId, prefix: r[0].prefix });
  return r.length > 0;
}
