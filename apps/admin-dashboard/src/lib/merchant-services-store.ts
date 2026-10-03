// Storage for a merchant's services (lib/merchant-services): providers.services, provider 0019.
// A banker has none of its own: it obeys the merchant it is mapped under.
//
// Imports only lib/pg and the banker-to-merchant lookup, so the order, payout and checkout cores
// can all import it. What a banker still needs before go-live is in lib/merchant-setup.

import { rows } from "@/lib/pg";
import { providerForMerchant } from "@/lib/provider-integration";
import { allowsPayin, allowsPayout, parseServices, type MerchantServicesSetting } from "@/lib/merchant-services";

/**
 * The services selected for a merchant (a `providers` row). A database that does not have the
 * column yet answers UNSET, which allows what was always allowed.
 */
export async function getProviderServices(providerId: string | null | undefined): Promise<MerchantServicesSetting> {
  if (!providerId) return "UNSET";
  const r = await rows<{ services: string }>("provider",
    `SELECT services FROM providers WHERE id = $1::uuid`, [providerId]).catch(() => []);
  return parseServices(r[0]?.services);
}

/** The services a banker obeys: its merchant's. UNSET when it is mapped under none. */
export async function getBankerServices(merchantCode: string | null | undefined): Promise<MerchantServicesSetting> {
  if (!merchantCode) return "UNSET";
  return getProviderServices(await providerForMerchant(merchantCode).catch(() => null));
}

/** Select a merchant's services (UNSET clears the choice) and record the change. */
export async function setProviderServices(
  providerId: string, c: { services: MerchantServicesSetting; by: string; note?: string | null },
): Promise<{ ok: true; services: MerchantServicesSetting } | { ok: false; error: string }> {
  const before = await rows<{ services: string }>("provider", `SELECT services FROM providers WHERE id = $1::uuid`, [providerId]);
  if (!before.length) return { ok: false, error: "merchant not found" };
  await rows("provider", `
    UPDATE providers SET services = $2, services_set_by = $3, services_set_at = now() WHERE id = $1::uuid
  `, [providerId, c.services, c.by]);
  if (before[0].services !== c.services) {
    await rows("provider", `
      INSERT INTO provider_services_history (provider_id, from_services, to_services, changed_by, note)
      VALUES ($1::uuid, $2, $3, $4, $5)
    `, [providerId, before[0].services, c.services, c.by, c.note?.trim() || null]);
  }
  return { ok: true, services: c.services };
}

export interface ServicesHistoryRow { from_services: string | null; to_services: string; changed_by: string | null; note: string | null; changed_at: string }

export async function providerServicesHistory(providerId: string): Promise<ServicesHistoryRow[]> {
  return rows<ServicesHistoryRow>("provider", `
    SELECT from_services, to_services, changed_by, note, changed_at
      FROM provider_services_history WHERE provider_id = $1::uuid ORDER BY changed_at DESC LIMIT 20
  `, [providerId]).catch(() => []);
}

/**
 * Why this banker may not use a service, or null when it may. The one check behind every
 * route that takes a pay-in or sends a payout.
 */
export async function serviceRefusal(
  merchantCode: string | null | undefined, service: "PAYIN" | "PAYOUT",
): Promise<{ error: string; code: "PAYIN_NOT_ENABLED" | "PAYOUT_NOT_ENABLED" } | null> {
  const s = await getBankerServices(merchantCode);
  if (service === "PAYIN" && !allowsPayin(s)) return { error: "pay-ins are not enabled for this merchant", code: "PAYIN_NOT_ENABLED" };
  if (service === "PAYOUT" && !allowsPayout(s)) return { error: "payouts are not enabled for this merchant", code: "PAYOUT_NOT_ENABLED" };
  return null;
}
