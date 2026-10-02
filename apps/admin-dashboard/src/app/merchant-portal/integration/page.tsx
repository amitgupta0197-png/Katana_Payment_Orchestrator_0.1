// Merchant (PROVIDER) integration guide, plus the Key + Salt for each of the merchant's
// bankers (issued through /api/merchants/[id]/checkout-key, which a PROVIDER may call for
// its own bankers). Endpoints are rendered from PUBLIC_BASE_URL server-side so a staging
// deploy shows its own URLs.

import { IntegrationGuide } from "./guide";

export const dynamic = "force-dynamic";

export default function MerchantIntegrationPage() {
  const base = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
  return <IntegrationGuide base={base} />;
}
