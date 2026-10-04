// Shared pieces of the pay-in flow admin APIs.

import { z } from "zod";
import { rows } from "@/lib/pg";
import { getGatewayMid } from "@/lib/gateway-creds";
import { gatewayAccountChannel } from "@/lib/pg-catalog";

export const flowChangeSchema = z.object({
  // UNSET clears the selection: a merchant goes back to "not selected", a banker back to
  // inheriting its merchant's flow.
  flow: z.enum(["P2P", "INTENT", "BOTH", "UNSET"]),
  // BOTH only: the flow in use.
  active: z.enum(["P2P", "INTENT"]).nullish(),
  note: z.string().trim().max(300).optional(),
});

/** What each flow needs before a banker can take a live order on it. */
export interface FlowReadiness {
  /** P2P: a settlement UPI ID to be paid on, or a P2P processor account (e.g. PayAtom on P2P). */
  p2p: boolean;
  /** Intent: a pay-in gateway account connected that runs on the Intent flow. */
  intent: boolean;
}

/** Readiness of many bankers at once, keyed by merchant_code. */
export async function flowReadiness(codes: string[]): Promise<Map<string, FlowReadiness>> {
  const out = new Map<string, FlowReadiness>(codes.map((c) => [c, { p2p: false, intent: false }]));
  if (!codes.length) return out;
  const [vpas, mids] = await Promise.all([
    rows<{ merchant_code: string }>("merchant", `
      SELECT merchant_code FROM merchant_payment_config
       WHERE merchant_code = ANY($1::text[]) AND COALESCE(katana_pay->>'settlement_vpa', '') <> ''
    `, [codes]).catch(() => []),
    rows<{ owner_id: string }>("checkout", `
      SELECT DISTINCT owner_id FROM credential_vault
       WHERE kind = 'mid_secret' AND owner_type = 'merchant' AND label = 'gateway_mid'
         AND enabled = true AND owner_id = ANY($1::text[])
    `, [codes]).catch(() => []),
  ]);
  for (const v of vpas) { const r = out.get(v.merchant_code); if (r) r.p2p = true; }
  // Which flow the first account runs on is inside its sealed credentials (lib/pg-catalog
  // gatewayAccountChannel); a credential that cannot be read counts as Intent, as before.
  const channels = await Promise.all(mids.map(async (m) =>
    [m.owner_id, gatewayAccountChannel(await getGatewayMid(m.owner_id).catch(() => null) ?? { gateway: "" })] as const));
  for (const [code, ch] of channels) {
    const r = out.get(code);
    if (r) { if (ch === "P2P") r.p2p = true; else r.intent = true; }
  }
  return out;
}
