// Settlement VPAs of a banker — the UPI IDs its money lands on.
//
// A banker collects on more than one UPI ID in practice (a second bank account, a QR
// printed before the account was switched, a personal handle used while the business one
// was being approved). Reconciliation has to recognise every one of them, but a payment
// REQUEST still has exactly one payee — so the config keeps one PRIMARY
// (`poolpay.settlement_vpa`) and a list of ADDITIONAL ones (`poolpay.settlement_vpas`):
//
//   settlement_vpa   — where Katana Pay orders are paid TO. Exactly one, always.
//   settlement_vpas  — extra IDs this banker also receives on. Recognised when attributing
//                      and reported on; never used as a payee.
//
// Everything that asks "does this credit belong to this banker" must go through here so
// the two lists can never drift apart.
//
// WHAT THIS DOES NOT FIX: two bankers can be configured with the SAME VPA (PRIMESX and
// PRVZS23 both use 9355449766@okbizaxis today). A credit carrying no banker code cannot be
// attributed to either of them by its VPA alone — which is why callers use these lists only
// as a fallback for untagged credits, and why the banker code stamped by the agent stays
// the authority. Adding VPAs here widens recognition; it does not resolve that ambiguity.

import { rows } from "./pg";

/** UPI IDs are case-insensitive, and captured alerts store them lowercased. */
function normalise(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s || null;
}

/** Primary + additional VPAs held in one `poolpay` config blob, deduped. */
export function vpasFromConfig(poolpay: unknown): string[] {
  const p = (poolpay ?? {}) as { settlement_vpa?: unknown; settlement_vpas?: unknown };
  const out = new Set<string>();
  const primary = normalise(p.settlement_vpa);
  if (primary) out.add(primary);
  if (Array.isArray(p.settlement_vpas)) {
    for (const v of p.settlement_vpas) {
      const n = normalise(v);
      if (n) out.add(n);
    }
  }
  return [...out];
}

/** Every settlement VPA configured for these banker codes, primary and additional alike. */
export async function settlementVpasFor(codes: string[]): Promise<string[]> {
  if (!codes.length) return [];
  const res = await rows<{ poolpay: unknown }>(
    "merchant",
    `SELECT poolpay FROM merchant_payment_config WHERE merchant_code = ANY($1::text[])`,
    [codes],
  ).catch(() => []);
  const out = new Set<string>();
  for (const r of res) for (const v of vpasFromConfig(r.poolpay)) out.add(v);
  return [...out];
}
