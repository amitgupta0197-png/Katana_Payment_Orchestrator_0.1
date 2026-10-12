// Shared pieces of the pay-in flow admin APIs.

import { headlessAccounts } from "@/lib/headless-store";
import { z } from "zod";
import { rows } from "@/lib/pg";
import { getGatewayMid } from "@/lib/gateway-creds";
import { gatewayAccountChannel, gatewayTakesIntent } from "@/lib/pg-catalog";
import type { P2pMethod } from "@/lib/p2p-method";
import { bharatpeReadyCodes, getP2pMethods } from "@/lib/p2p-method-store";

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
  /**
   * P2P: what its chosen method needs (lib/p2p-method): UPI ID → a settlement UPI ID; BharatPe →
   * an active BharatPe MID whose UPI ID is the settlement one; PayAtom → its first account is a P2P
   * processor account. None chosen: a settlement UPI ID or a P2P processor account, as before.
   */
  p2p: boolean;
  /** The banker's chosen P2P method, null when none is chosen. */
  p2pMethod: P2pMethod | null;
  /** Intent: a pay-in gateway account connected that runs on the Intent flow. */
  intent: boolean;
}

/** Readiness of many bankers at once, keyed by merchant_code. */
export async function flowReadiness(codes: string[]): Promise<Map<string, FlowReadiness>> {
  const out = new Map<string, FlowReadiness>(codes.map((c) => [c, { p2p: false, intent: false, p2pMethod: null }]));
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
  const methods = await getP2pMethods(codes);
  // Quasi-headless: any live PhonePe / Paytm account of the banker saved for P2P (not only its first).
  const headless = new Set((await Promise.all([...methods].filter(([, m]) => m === "HEADLESS")
    .map(async ([c]) => ((await headlessAccounts(c, true).catch(() => [])).length ? c : null)))).filter(Boolean) as string[]);
  const bharatpe = await bharatpeReadyCodes([...methods].filter(([, m]) => m === "BHARATPE").map(([c]) => c));
  const hasVpa = new Set(vpas.map((v) => v.merchant_code));
  // Which flow the first account runs on is inside its sealed credentials (lib/pg-catalog
  // gatewayAccountChannel); a credential that cannot be read counts as Intent, as before.
  const channels = await Promise.all(mids.map(async (m) => {
    const mid = await getGatewayMid(m.owner_id).catch(() => null);
    return [m.owner_id, gatewayAccountChannel(mid ?? { gateway: "" }), mid?.gateway ?? ""] as const;
  }));
  const p2pAccount = new Map<string, string>();
  for (const [code, ch, gw] of channels) {
    const r = out.get(code);
    if (!r) continue;
    // A P2P-only gateway's Intent account (PayAtom, saved before 2026-10-12) takes no Intent order.
    if (ch === "P2P") p2pAccount.set(code, gw); else if (gatewayTakesIntent(gw)) r.intent = true;
  }
  for (const [code, r] of out) {
    const method = methods.get(code) ?? null;
    r.p2pMethod = method;
    r.p2p = method === "UPI_ID" ? hasVpa.has(code)
      : method === "BHARATPE" ? bharatpe.has(code)
      : method === "PAYATOM" ? p2pAccount.get(code) === "PAYATOM"
      : method === "HEADLESS" ? headless.has(code)
      : hasVpa.has(code) || p2pAccount.has(code);
  }
  return out;
}
