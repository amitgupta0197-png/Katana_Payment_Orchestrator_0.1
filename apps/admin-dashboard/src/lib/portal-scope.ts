// Whose orders, webhooks and request log a signed-in user may see on the order desk
// (/api/portal/*): one set of routes serves the merchant portal, the banker portal and staff.
//
//   staff      every banker (codes = null)
//   PROVIDER   the bankers mapped under the merchant
//   MERCHANT   the banker itself
//
// A non-staff session is a merchant for the purposes of lib/merchant-safe: it is never shown a
// gateway's name, an internal reason code or a request body.

import type { Persona, Session } from "@/lib/auth";
import { resolveProviderMerchants } from "@/lib/scope";
import { ownMerchantCode } from "@/lib/merchant-keys";
import { seesGatewayNames } from "@/lib/merchant-safe";

export const PORTAL_PERSONAS: Persona[] = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT", "PROVIDER", "MERCHANT"];
export const STAFF_PERSONAS: Persona[] = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"];

export interface PortalScope {
  staff: boolean;
  /** The banker codes in scope; null = all (staff). */
  codes: string[] | null;
}

export async function portalScope(s: Session): Promise<PortalScope> {
  if (seesGatewayNames(s.persona)) return { staff: true, codes: null };
  if (s.persona === "PROVIDER") return { staff: false, codes: await resolveProviderMerchants(s) };
  if (s.persona === "MERCHANT") {
    const code = await ownMerchantCode(s.scope_id);
    return { staff: false, codes: code ? [code] : [] };
  }
  return { staff: false, codes: [] };
}

/**
 * True when the session may read or act on an order of this banker. Staff may on any; a
 * merchant or banker login only on its own bankers' orders, and never on one with no banker
 * (a staff test order). Callers answer "not found" otherwise: whether an order exists is
 * information too.
 */
export async function orderInScope(s: Session, merchantId: string | null | undefined): Promise<boolean> {
  return inScope(await portalScope(s), merchantId) || (seesGatewayNames(s.persona) && !merchantId);
}

/** True when this banker is one the session may act on. */
export function inScope(scope: PortalScope, merchantCode: string | null | undefined): boolean {
  return !!merchantCode && (scope.codes === null || scope.codes.includes(merchantCode));
}
