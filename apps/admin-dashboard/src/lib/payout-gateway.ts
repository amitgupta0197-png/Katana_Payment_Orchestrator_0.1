// The merchant's payout gateway: which gateway pays their payouts, and its sealed credentials.
//
// One per merchant (vault label "payout_gateway"). Fields follow lib/pg-catalog. Gateways with a
// payout connector (lib/payout-providers) send the money; a merchant whose payout gateway has no
// connector keeps the operator queue.

import { storeCredential, readCredential } from "@/lib/credential-vault";
import { gatewayDef, hint, type GatewayEnv, type GatewayId } from "@/lib/pg-catalog";

export interface PayoutGatewayCreds {
  gateway: GatewayId;
  env: GatewayEnv;
  fields: Record<string, string>;
  /** Shared secret registered with the gateway's webhook API, echoed on every event. */
  webhook_token?: string;
  webhook_registered_at?: string;
}

const VAULT_LABEL = "payout_gateway";

export async function storePayoutGateway(merchantCode: string, creds: PayoutGatewayCreds): Promise<void> {
  await storeCredential({
    kind: "mid_secret", ownerType: "merchant", ownerId: merchantCode,
    label: VAULT_LABEL, plaintext: JSON.stringify(creds),
  });
}

export async function getPayoutGateway(merchantCode: string): Promise<PayoutGatewayCreds | null> {
  const pt = await readCredential({ kind: "mid_secret", ownerType: "merchant", ownerId: merchantCode, label: VAULT_LABEL });
  if (!pt) return null;
  try { return JSON.parse(pt) as PayoutGatewayCreds; } catch { return null; }
}

// Non-secret view for the admin UI: no secret values, no webhook token.
export type PayoutGatewayStatus =
  | { configured: false }
  | {
      configured: true; gateway: GatewayId; gateway_name: string; connector: boolean;
      webhook: "api" | "dashboard" | "per_transfer" | null; balance: boolean;
      env: GatewayEnv; env_label: string;
      /** Non-secret fields as saved, secret ones as a hint. */
      summary: { label: string; value: string }[];
      webhook_registered_at: string | null;
    };

export async function getPayoutGatewayStatus(merchantCode: string): Promise<PayoutGatewayStatus> {
  const c = await getPayoutGateway(merchantCode);
  if (!c) return { configured: false };
  const svc = gatewayDef(c.gateway)?.payout;
  return {
    configured: true, gateway: c.gateway, gateway_name: gatewayDef(c.gateway)?.name ?? c.gateway,
    connector: svc?.connector ?? false,
    webhook: svc?.webhook ?? null, balance: svc?.balance ?? false,
    env: c.env, env_label: svc?.env[c.env] ?? c.env,
    summary: (svc?.fields ?? []).filter((f) => c.fields[f.name]).map((f) => ({
      label: f.label, value: f.secret ? "sealed" : f.show ? c.fields[f.name] : hint(c.fields[f.name]),
    })),
    webhook_registered_at: c.webhook_registered_at ?? null,
  };
}
