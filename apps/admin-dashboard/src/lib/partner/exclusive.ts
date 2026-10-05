// Whether a merchant is an exclusive partner (lib/partner, vendorGateway 0044): its bankers take
// partner orders only. Imports nothing but lib/pg, so the pay-in core can ask without a cycle.

import { rows } from "@/lib/pg";

/** Before 0044 is applied there are no partners, and every order goes exactly as before. */
const missing = (err: unknown) => ["42P01", "42703"].includes((err as { code?: string }).code ?? "");

/** True when this merchant (a `providers` id) is a partner whose bankers take partner orders only. */
export async function isExclusivePartner(providerId: string | null | undefined): Promise<boolean> {
  if (!providerId) return false;
  const r = await rows<{ exclusive: boolean }>("vendorGateway",
    `SELECT exclusive FROM partners WHERE provider_id = $1`, [providerId])
    .catch((e) => { if (missing(e)) return []; throw e; });
  return r[0]?.exclusive === true;
}
