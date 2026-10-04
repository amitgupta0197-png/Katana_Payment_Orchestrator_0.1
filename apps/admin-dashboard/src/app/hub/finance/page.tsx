"use client";

// Finance hub: /commission, /partner-data, /reserves as tabs (?tab=). Each tab is the existing
// page, unchanged; its own URL keeps working (lib/nav navHubs, components/layout/hub-page).

import { HubPage } from "@/components/layout/hub-page";
import CommissionPage from "@/app/commission/page";
import PartnerDataPage from "@/app/partner-data/page";
import ReservesPage from "@/app/reserves/page";

export default function HubFinancePage() {
  return <HubPage href="/hub/finance" components={{ "commission": CommissionPage, "partner-data": PartnerDataPage, "reserves": ReservesPage }} />;
}
