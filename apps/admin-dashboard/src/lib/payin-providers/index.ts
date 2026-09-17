// Pay-in connectors by gateway id (every gateway except PayU, which has lib/payu-*).

import type { GatewayMid } from "@/lib/gateway-creds";
import { getGatewayMid } from "@/lib/gateway-creds";
import { razorpayPayin } from "@/lib/payin-providers/razorpay";
import { cashfreePayin } from "@/lib/payin-providers/cashfree";
import { phonepePayin } from "@/lib/payin-providers/phonepe";
import { paytmPayin } from "@/lib/payin-providers/paytm";
import { ccavenuePayin } from "@/lib/payin-providers/ccavenue";
import type { PayinConnector } from "@/lib/payin-providers/types";

const CONNECTORS: Record<string, PayinConnector> = {
  RAZORPAY: razorpayPayin,
  CASHFREE: cashfreePayin,
  PHONEPE: phonepePayin,
  PAYTM: paytmPayin,
  CCAVENUE: ccavenuePayin,
};

export const PAYIN_GATEWAYS = Object.keys(CONNECTORS);

export function payinConnector(id: string | null | undefined): PayinConnector | null {
  return (id && CONNECTORS[id]) || null;
}

/** The merchant's gateway credentials and connector, when their pay-in gateway is a non-PayU one. */
export async function gatewayPayinFor(merchantCode: string): Promise<{ mid: GatewayMid; connector: PayinConnector } | null> {
  const mid = await getGatewayMid(merchantCode).catch(() => null);
  const connector = payinConnector(mid?.gateway);
  return mid && connector ? { mid, connector } : null;
}
