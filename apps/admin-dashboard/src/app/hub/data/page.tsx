"use client";

// Order data hub: /payin-data, /payout-data as tabs (?tab=). Each tab is the existing
// page, unchanged; its own URL keeps working (lib/nav navHubs, components/layout/hub-page).

import { HubPage } from "@/components/layout/hub-page";
import PayinDataPage from "@/app/payin-data/page";
import PayoutDataPage from "@/app/payout-data/page";

export default function HubDataPage() {
  return <HubPage href="/hub/data" components={{ "payin": PayinDataPage, "payout": PayoutDataPage }} />;
}
