// Merchant (PROVIDER) integration guide. Read-only on purpose: unlike the banker
// portal there is no PROVIDER-scoped credentials API, so this page documents the
// integration and points at where the Key + Salt is actually issued. Endpoints are
// rendered from PUBLIC_BASE_URL server-side so a staging deploy shows its own URLs.

import { IntegrationGuide } from "./guide";

export const dynamic = "force-dynamic";

export default function MerchantIntegrationPage() {
  const base = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
  return <IntegrationGuide base={base} />;
}
