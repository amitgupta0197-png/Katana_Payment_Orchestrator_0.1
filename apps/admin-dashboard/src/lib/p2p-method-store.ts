// Storage for a banker's P2P method (merchant 0027; rules in lib/p2p-method).
//
// Reads fail soft to "not chosen" (null), which is the old routing: a database without the
// migration, or a read that fails, never refuses an order.

import { headlessAccounts } from "@/lib/headless-store";
import { rows } from "@/lib/pg";
import { getGatewayMid } from "@/lib/gateway-creds";
import { gatewayAccountChannel } from "@/lib/pg-catalog";
import { asP2pApp, asP2pMethod, type P2pApp, type P2pFacts, type P2pMethod } from "@/lib/p2p-method";

const ONLINE_SEC = 600;

/** A banker's chosen P2P method, or null when none is chosen (or it can't be read). */
export async function getP2pMethod(merchantCode: string | null | undefined): Promise<P2pMethod | null> {
  if (!merchantCode) return null;
  const r = await rows<{ m: string | null }>("merchant",
    `SELECT p2p_method AS m FROM merchants WHERE merchant_code = $1`, [merchantCode]).catch(() => []);
  return asP2pMethod(r[0]?.m);
}

/** The payment app a scan-and-pay banker's QR belongs to (merchant 0028), or null. */
export async function getP2pApp(merchantCode: string): Promise<P2pApp | null> {
  const r = await rows<{ a: string | null }>("merchant",
    `SELECT p2p_app AS a FROM merchants WHERE merchant_code = $1`, [merchantCode]).catch(() => []);
  return asP2pApp(r[0]?.a);
}

/** Record the app (null clears it). Not a routing setting, so it is not part of the method history. */
export async function setP2pApp(merchantCode: string, app: P2pApp | null): Promise<void> {
  await rows("merchant", `UPDATE merchants SET p2p_app = $2 WHERE merchant_code = $1`, [merchantCode, app]);
}

/** Chosen methods of many bankers; bankers with none are left out. */
export async function getP2pMethods(codes: string[]): Promise<Map<string, P2pMethod>> {
  if (!codes.length) return new Map();
  const r = await rows<{ merchant_code: string; m: string | null }>("merchant",
    `SELECT merchant_code, p2p_method AS m FROM merchants WHERE merchant_code = ANY($1::text[]) AND p2p_method IS NOT NULL`,
    [codes]).catch(() => []);
  return new Map(r.flatMap((x) => { const m = asP2pMethod(x.m); return m ? [[x.merchant_code, m] as const] : []; }));
}

/** Bankers (of those given) with an ACTIVE BharatPe MID whose UPI ID is the one customers pay. */
export async function bharatpeReadyCodes(codes: string[]): Promise<Set<string>> {
  if (!codes.length) return new Set();
  const vpas = await rows<{ merchant_code: string; vpa: string }>("merchant", `
    SELECT merchant_code, lower(katana_pay->>'settlement_vpa') AS vpa FROM merchant_payment_config
     WHERE merchant_code = ANY($1::text[]) AND COALESCE(katana_pay->>'settlement_vpa', '') <> ''`, [codes]).catch(() => []);
  if (!vpas.length) return new Set();
  const mids = await rows<{ merchant_code: string; vpa: string }>("vendorGateway", `
    SELECT merchant_code, lower(payee_vpa) AS vpa FROM bharatpe_mids
     WHERE merchant_code = ANY($1::text[]) AND status = 'ACTIVE'`, [vpas.map((v) => v.merchant_code)]).catch(() => []);
  const want = new Map(vpas.map((v) => [v.merchant_code, v.vpa]));
  return new Set(mids.filter((m) => want.get(m.merchant_code) === m.vpa).map((m) => m.merchant_code));
}

/** Everything the P2P methods need, as set up for this banker now. */
export async function p2pFacts(merchantCode: string): Promise<P2pFacts> {
  const [cfg, mids, first, phones] = await Promise.all([
    rows<{ vpa: string | null }>("merchant",
      `SELECT katana_pay->>'settlement_vpa' AS vpa FROM merchant_payment_config WHERE merchant_code = $1`, [merchantCode]).catch(() => []),
    rows<{ label: string; env: "TEST" | "PROD"; status: string; vpa: string }>("vendorGateway",
      `SELECT label, env, status, lower(payee_vpa) AS vpa FROM bharatpe_mids WHERE merchant_code = $1 ORDER BY created_at DESC`,
      [merchantCode]).catch(() => []),
    getGatewayMid(merchantCode).catch(() => null),
    rows<{ enrolled: number; online: number }>("vendorGateway", `
      SELECT COUNT(*)::int AS enrolled,
             COUNT(*) FILTER (WHERE status = 'TRUSTED' AND notif_access = true AND agent_enabled IS DISTINCT FROM false
                                AND last_heartbeat >= now() - ($2 || ' seconds')::interval)::int AS online
        FROM vendor_devices WHERE merchant_id = $1`, [merchantCode, String(ONLINE_SEC)]).catch(() => []),
  ]);
  const upiId = cfg[0]?.vpa?.trim() || null;
  const bp = upiId ? mids.find((m) => m.status === "ACTIVE" && m.vpa === upiId.toLowerCase()) : undefined;
  return {
    upiId,
    bharatpeMid: bp ? { label: bp.label, env: bp.env } : null,
    bharatpeAny: mids.length,
    payatomP2p: first && first.gateway === "PAYATOM" && gatewayAccountChannel(first) === "P2P" ? { env: first.env ?? "TEST" } : null,
    headlessPsps: (await headlessAccounts(merchantCode, false).catch(() => [])).map((a) => a.psp),
    phones: { enrolled: phones[0]?.enrolled ?? 0, online: phones[0]?.online ?? 0 },
  };
}

/** Set a banker's method (null: back to "not chosen") and record the change. */
export async function setP2pMethod(
  merchantCode: string, c: { value: P2pMethod | null; by: string; note?: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const before = await rows<{ m: string | null }>("merchant", `SELECT p2p_method AS m FROM merchants WHERE merchant_code = $1`, [merchantCode]);
  if (!before.length) return { ok: false, error: "banker not found" };
  await rows("merchant", `
    UPDATE merchants SET p2p_method = $2, p2p_method_set_by = $3, p2p_method_set_at = now() WHERE merchant_code = $1
  `, [merchantCode, c.value, c.by]);
  if ((before[0].m ?? null) !== c.value) {
    await rows("merchant", `
      INSERT INTO merchant_p2p_method_history (merchant_code, from_method, to_method, changed_by, note)
      VALUES ($1, $2, $3, $4, $5)
    `, [merchantCode, before[0].m ?? null, c.value, c.by, c.note?.trim() || null]);
  }
  return { ok: true };
}

export interface P2pMethodHistoryRow { from_method: string | null; to_method: string | null; changed_by: string | null; note: string | null; changed_at: string }

export async function p2pMethodHistory(merchantCode: string): Promise<P2pMethodHistoryRow[]> {
  return rows<P2pMethodHistoryRow>("merchant", `
    SELECT from_method, to_method, changed_by, note, changed_at
      FROM merchant_p2p_method_history WHERE merchant_code = $1 ORDER BY changed_at DESC LIMIT 20
  `, [merchantCode]).catch(() => []);
}
