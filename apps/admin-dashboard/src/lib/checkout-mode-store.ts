// Host-to-host (H2H) vs redirect, stored and read (provider 0023). The rule of which gateway
// account is which is pure, in lib/pg-catalog gatewayCheckoutMode.
//
//   providers.needs_h2h   a merchant whose integration shows the UPI link itself. Its bankers
//                         may not be given a redirect-only account (H2H_REQUIRED) and readiness
//                         flags one that has one.
//
// A database without the column answers false, which is what every merchant was before.

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

/** Whether a banker's merchant needs H2H. False when it is mapped under none. */
export async function bankerNeedsH2h(merchantCode: string | null | undefined): Promise<boolean> {
  if (!merchantCode) return false;
  return getProviderNeedsH2h(await providerForMerchant(merchantCode).catch(() => null));
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
