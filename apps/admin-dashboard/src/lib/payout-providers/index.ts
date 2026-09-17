// Payout connectors by gateway id, and the merchant's active one.

import type { GatewayEnv, GatewayId } from "@/lib/pg-catalog";
import { getPayoutGateway } from "@/lib/payout-gateway";
import { payuConnector } from "@/lib/payout-providers/payu";
import { razorpayConnector } from "@/lib/payout-providers/razorpay";
import { cashfreeConnector } from "@/lib/payout-providers/cashfree";
import { paytmConnector } from "@/lib/payout-providers/paytm";
import type { PayoutConnector } from "@/lib/payout-providers/types";

export type AnyConnector = PayoutConnector<{ env: GatewayEnv }>;

const CONNECTORS: Partial<Record<GatewayId, AnyConnector>> = {
  PAYU: payuConnector as unknown as AnyConnector,
  RAZORPAY: razorpayConnector as unknown as AnyConnector,
  CASHFREE: cashfreeConnector as unknown as AnyConnector,
  PAYTM: paytmConnector as unknown as AnyConnector,
};

export const PAYOUT_PROVIDERS = Object.keys(CONNECTORS) as GatewayId[];

export function payoutConnector(id: string | null | undefined): AnyConnector | null {
  return (id && CONNECTORS[id as GatewayId]) || null;
}

export interface ActivePayout {
  connector: AnyConnector;
  creds: { env: GatewayEnv };
}

/**
 * The connector and credentials that pay this merchant's payouts, or null when the merchant's
 * payout gateway has none (their payouts go to the operator queue).
 */
export async function activePayoutProvider(merchantCode: string): Promise<ActivePayout | null> {
  const g = await getPayoutGateway(merchantCode);
  const connector = payoutConnector(g?.gateway);
  if (!connector) return null;
  const creds = await connector.creds(merchantCode);
  return creds ? { connector, creds } : null;
}

/** Credentials for a specific gateway, only if it is still the merchant's payout gateway. */
export async function providerCreds(provider: string, merchantCode: string): Promise<ActivePayout | null> {
  const connector = payoutConnector(provider);
  if (!connector) return null;
  const creds = await connector.creds(merchantCode);
  return creds ? { connector, creds } : null;
}

export { prodEnabled, payoutWebhookUrlFor } from "@/lib/payout-providers/types";
export type { PayoutRail, TransferState } from "@/lib/payout-providers/types";
