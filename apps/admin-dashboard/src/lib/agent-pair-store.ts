// Pairing codes for Katana Agent phones (vendorGateway 0047; rules in lib/agent-pair).

import { createHash, randomBytes } from "crypto";
import { rows } from "@/lib/pg";
import { agentAppFor, pairCodeFrom, PAIR_TTL_MINUTES, type PairPayload } from "@/lib/agent-pair";
import { getP2pApp, getP2pMethod } from "@/lib/p2p-method-store";
import { bharatpeMidByApiKey } from "@/lib/bharatpe-store";

const hash = (code: string) => createHash("sha256").update(code).digest("hex");

/** A new one-time code for this banker. Earlier unused codes for it stop working. */
export async function createPairCode(merchantCode: string, by: string): Promise<{ code: string; expires_at: string }> {
  await rows("vendorGateway",
    `UPDATE agent_pair_codes SET used_at = now(), used_by_device = 'superseded' WHERE merchant_code = $1 AND used_at IS NULL`, [merchantCode]);
  const code = pairCodeFrom(randomBytes(16));
  const r = await rows<{ expires_at: string }>("vendorGateway", `
    INSERT INTO agent_pair_codes (code_hash, merchant_code, created_by, expires_at)
    VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval) RETURNING expires_at::text`,
    [hash(code), merchantCode, by, String(PAIR_TTL_MINUTES)]);
  return { code, expires_at: r[0].expires_at };
}

export class PairError extends Error { constructor(readonly status: number, message: string) { super(message); } }

/**
 * Redeem a code (once): the banker's setup for the phone. The BharatPe MID is the active one for
 * the UPI ID customers pay; its secret is opened here and handed to this phone only.
 */
export async function redeemPairCode(code: string, deviceId: string, baseUrl: string): Promise<PairPayload> {
  const used = await rows<{ merchant_code: string }>("vendorGateway", `
    UPDATE agent_pair_codes SET used_at = now(), used_by_device = $2
     WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING merchant_code`, [hash(code), deviceId.slice(0, 80)]);
  if (!used.length) throw new PairError(404, "This pairing code is wrong, already used or expired. Ask for a new one.");
  const merchantCode = used[0].merchant_code;

  const [m, method, app, cfg] = await Promise.all([
    rows<{ name: string }>("merchant", `SELECT COALESCE(NULLIF(brand_name, ''), legal_name) AS name FROM merchants WHERE merchant_code = $1`, [merchantCode]),
    getP2pMethod(merchantCode),
    getP2pApp(merchantCode),
    rows<{ vpa: string | null }>("merchant", `SELECT lower(katana_pay->>'settlement_vpa') AS vpa FROM merchant_payment_config WHERE merchant_code = $1`, [merchantCode]),
  ]);
  let bharatpe: PairPayload["bharatpe"] = null;
  if (method === "BHARATPE" || app === "BHARATPE") {
    const vpa = cfg[0]?.vpa ?? null;
    const mid = (await rows<{ api_key: string }>("vendorGateway", `
      SELECT api_key FROM bharatpe_mids
       WHERE merchant_code = $1 AND status = 'ACTIVE' AND ($2::text IS NULL OR lower(payee_vpa) = $2)
       ORDER BY created_at DESC LIMIT 1`, [merchantCode, vpa]))[0];
    if (mid) {
      const auth = await bharatpeMidByApiKey(mid.api_key);
      if (auth?.secret) bharatpe = { api_key: mid.api_key, secret: auth.secret, env: auth.env };
    }
  }
  return {
    merchant_code: merchantCode,
    merchant_name: m[0]?.name ?? merchantCode,
    base_url: baseUrl,
    capture_app: agentAppFor(method === "BHARATPE" ? "BHARATPE" : app),
    bharatpe,
  };
}
