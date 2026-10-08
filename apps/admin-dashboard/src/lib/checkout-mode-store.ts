// Host-to-host (H2H) vs redirect, stored and read (provider 0023). The rule of which gateway
// account is which is pure, in lib/pg-catalog gatewayCheckoutMode.
//
//   providers.needs_h2h   a merchant whose integration shows the UPI link itself. Its bankers
//                         may not be given a redirect-only account (H2H_REQUIRED) and readiness
//                         flags one that has one.
//   merchants.needs_h2h   (merchant 0026) a banker's own choice, which wins over its merchant's:
//                         NULL = the merchant's, true = H2H, false = redirect is fine.
//
// A database without the columns answers false / NULL, which is what everyone was before.

import { rows } from "@/lib/pg";
import { providerForMerchant } from "@/lib/provider-integration";
import { getGatewayMid } from "@/lib/gateway-creds";
import { gatewayAccountChannel, gatewayCheckoutMode, type CheckoutMode } from "@/lib/pg-catalog";
import { getEffectiveFlow } from "@/lib/payin-flow-store";

/** Whether a merchant (a `providers` row) needs H2H. */
export async function getProviderNeedsH2h(providerId: string | null | undefined): Promise<boolean> {
  if (!providerId) return false;
  const r = await rows<{ needs_h2h: boolean }>("provider",
    `SELECT needs_h2h FROM providers WHERE id = $1::uuid`, [providerId]).catch(() => []);
  return r[0]?.needs_h2h === true;
}

/** A banker's own choice wins; with none (NULL) it follows its merchant's. */
export const effectiveNeedsH2h = (own: boolean | null, merchant: boolean): boolean => own ?? merchant;

/** A banker's own choice, or null when it follows its merchant's (or before merchant 0026). */
async function bankerOwnH2h(merchantCode: string): Promise<boolean | null> {
  const r = await rows<{ needs_h2h: boolean | null }>("merchant",
    `SELECT needs_h2h FROM merchants WHERE merchant_code = $1`, [merchantCode]).catch(() => []);
  return r[0]?.needs_h2h ?? null;
}

/** Bankers with a choice of their own, for lists (readiness). */
export async function bankersOwnH2h(codes: string[]): Promise<Map<string, boolean>> {
  if (!codes.length) return new Map();
  const r = await rows<{ merchant_code: string; needs_h2h: boolean }>("merchant",
    `SELECT merchant_code, needs_h2h FROM merchants WHERE merchant_code = ANY($1::text[]) AND needs_h2h IS NOT NULL`, [codes]).catch(() => []);
  return new Map(r.map((x) => [x.merchant_code, x.needs_h2h]));
}

export interface BankerH2h {
  /** The banker's own choice; null = its merchant's. */
  own: boolean | null;
  /** Its merchant's choice (false when it is mapped under none). */
  merchant: boolean;
  /** The merchant has a recorded choice (off with no history = nobody chose). */
  merchant_chosen: boolean;
  effective: boolean;
  provider_id: string | null;
}

export async function getBankerH2h(merchantCode: string): Promise<BankerH2h> {
  const providerId = await providerForMerchant(merchantCode).catch(() => null);
  const [own, merchant, hist] = await Promise.all([
    bankerOwnH2h(merchantCode),
    getProviderNeedsH2h(providerId),
    providerId ? providerH2hHistory(providerId) : Promise.resolve([]),
  ]);
  return { own, merchant, merchant_chosen: merchant || hist.length > 0, effective: effectiveNeedsH2h(own, merchant), provider_id: providerId };
}

/** Whether a banker needs H2H: its own choice, else its merchant's. False when neither says so. */
export async function bankerNeedsH2h(merchantCode: string | null | undefined): Promise<boolean> {
  if (!merchantCode) return false;
  return (await getBankerH2h(merchantCode)).effective;
}

/** Set a banker's own choice (null: back to its merchant's) and record the change. */
export async function setBankerNeedsH2h(
  merchantCode: string, c: { value: boolean | null; by: string; note?: string | null },
): Promise<{ ok: true; value: boolean | null } | { ok: false; error: string }> {
  const before = await rows<{ needs_h2h: boolean | null }>("merchant", `SELECT needs_h2h FROM merchants WHERE merchant_code = $1`, [merchantCode]);
  if (!before.length) return { ok: false, error: "banker not found" };
  await rows("merchant", `
    UPDATE merchants SET needs_h2h = $2, needs_h2h_set_by = $3, needs_h2h_set_at = now() WHERE merchant_code = $1
  `, [merchantCode, c.value, c.by]);
  if (before[0].needs_h2h !== c.value) {
    await rows("merchant", `
      INSERT INTO merchant_h2h_history (merchant_code, from_value, to_value, changed_by, note)
      VALUES ($1, $2, $3, $4, $5)
    `, [merchantCode, before[0].needs_h2h, c.value, c.by, c.note?.trim() || null]);
  }
  return { ok: true, value: c.value };
}

export interface BankerH2hHistoryRow { from_value: boolean | null; to_value: boolean | null; changed_by: string | null; note: string | null; changed_at: string }

export async function bankerH2hHistory(merchantCode: string): Promise<BankerH2hHistoryRow[]> {
  return rows<BankerH2hHistoryRow>("merchant", `
    SELECT from_value, to_value, changed_by, note, changed_at
      FROM merchant_h2h_history WHERE merchant_code = $1 ORDER BY changed_at DESC LIMIT 20
  `, [merchantCode]).catch(() => []);
}

/** Switch a merchant's need for H2H on or off and record the change. */
export async function setProviderNeedsH2h(
  providerId: string, c: { value: boolean; by: string; note?: string | null },
): Promise<{ ok: true; value: boolean } | { ok: false; error: string }> {
  const before = await rows<{ needs_h2h: boolean }>("provider", `SELECT needs_h2h FROM providers WHERE id = $1::uuid`, [providerId]);
  if (!before.length) return { ok: false, error: "merchant not found" };
  await rows("provider", `
    UPDATE providers SET needs_h2h = $2, needs_h2h_set_by = $3, needs_h2h_set_at = now() WHERE id = $1::uuid
  `, [providerId, c.value, c.by]);
  if (before[0].needs_h2h !== c.value) {
    await rows("provider", `
      INSERT INTO provider_h2h_history (provider_id, from_value, to_value, changed_by, note)
      VALUES ($1::uuid, $2, $3, $4, $5)
    `, [providerId, before[0].needs_h2h, c.value, c.by, c.note?.trim() || null]);
  }
  return { ok: true, value: c.value };
}

export interface H2hHistoryRow { from_value: boolean | null; to_value: boolean; changed_by: string | null; note: string | null; changed_at: string }

export async function providerH2hHistory(providerId: string): Promise<H2hHistoryRow[]> {
  return rows<H2hHistoryRow>("provider", `
    SELECT from_value, to_value, changed_by, note, changed_at
      FROM provider_h2h_history WHERE provider_id = $1::uuid ORDER BY changed_at DESC LIMIT 20
  `, [providerId]).catch(() => []);
}

/**
 * How a banker's live orders are paid: its first payment account's mode. With no account, a
 * banker whose orders default to P2P is paid on its UPI ID through a UPI link (H2H); otherwise
 * null (no live checkout yet). An account on the P2P flow is H2H too.
 */
export async function bankerLiveCheckoutMode(merchantCode: string | null | undefined): Promise<CheckoutMode | null> {
  if (!merchantCode) return null;
  const mid = await getGatewayMid(merchantCode).catch(() => null);
  if (!mid) {
    const f = await getEffectiveFlow(merchantCode).catch(() => null);
    return f?.flow === "P2P" || (f?.flow === "BOTH" && f.active === "P2P") ? "H2H" : null;
  }
  if (gatewayAccountChannel(mid) === "P2P") return "H2H";
  return gatewayCheckoutMode(mid.gateway, mid.auth ?? null);
}
