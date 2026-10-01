// Pay-in connectors by gateway id (every gateway except PayU Key + Salt, which has lib/payu-*;
// PayU with a Client ID + Secret uses payu-links).

import type { GatewayMid } from "@/lib/gateway-creds";
import { getGatewayMid } from "@/lib/gateway-creds";
import { razorpayPayin } from "@/lib/payin-providers/razorpay";
import { cashfreePayin } from "@/lib/payin-providers/cashfree";
import { phonepePayin } from "@/lib/payin-providers/phonepe";
import { paytmPayin } from "@/lib/payin-providers/paytm";
import { ccavenuePayin } from "@/lib/payin-providers/ccavenue";
import { rubyvaultPayin } from "@/lib/payin-providers/rubyvault";
import { ismartpayPayin } from "@/lib/payin-providers/ismartpay";
import { payuLinksPayin } from "@/lib/payin-providers/payu-links";
import type { PayinConnector } from "@/lib/payin-providers/types";

const CONNECTORS: Record<string, PayinConnector> = {
  RAZORPAY: razorpayPayin,
  CASHFREE: cashfreePayin,
  PHONEPE: phonepePayin,
  PAYTM: paytmPayin,
  CCAVENUE: ccavenuePayin,
  RUBYVAULT: rubyvaultPayin,
  ISMARTPAY: ismartpayPayin,
};

export const PAYIN_GATEWAYS = Object.keys(CONNECTORS);

export function payinConnector(id: string | null | undefined): PayinConnector | null {
  return (id && CONNECTORS[id]) || null;
}

/** The connector for these saved credentials: by gateway, and for PayU by sign-in mode. */
export function payinConnectorFor(mid: GatewayMid | null | undefined): PayinConnector | null {
  if (!mid) return null;
  if (mid.gateway === "PAYU") return mid.auth === "client_credentials" ? payuLinksPayin : null;
  return payinConnector(mid.gateway);
}

/** The merchant's gateway credentials and connector, unless they use PayU Key + Salt (lib/payu-*). */
export async function gatewayPayinFor(merchantCode: string): Promise<{ mid: GatewayMid; connector: PayinConnector } | null> {
  const mid = await getGatewayMid(merchantCode).catch(() => null);
  const connector = payinConnectorFor(mid);
  return mid && connector ? { mid, connector } : null;
}
