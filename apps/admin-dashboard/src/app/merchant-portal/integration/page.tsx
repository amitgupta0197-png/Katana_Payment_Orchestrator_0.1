// Merchant (PROVIDER) integration guide, plus the Key + Salt for each of the merchant's
// bankers (issued through /api/merchants/[id]/checkout-key, which a PROVIDER may call for
// its own bankers). Endpoints are rendered from PUBLIC_BASE_URL server-side so a staging
// deploy shows its own URLs.

import { IntegrationGuide } from "./guide";
import { getSession } from "@/lib/auth";
import { getProviderServices } from "@/lib/merchant-services-store";
import { ServicesNotice } from "@/components/merchant/services";

export const dynamic = "force-dynamic";

export default async function MerchantIntegrationPage() {
  const base = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
  // What the merchant was onboarded for (lib/merchant-services): pay-in, pay-out or both.
  const session = await getSession();
  const services = session?.persona === "PROVIDER" ? await getProviderServices(session.scope_id).catch(() => "UNSET" as const) : "UNSET";
  return (
    <>
      <ServicesNotice services={services} />
      <IntegrationGuide base={base} />
    </>
  );
}
