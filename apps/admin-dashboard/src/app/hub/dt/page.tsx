"use client";

// DT hub: /dt-dashboard, /dt-purchases, /dt-refills as tabs (?tab=). Each tab is the existing
// page, unchanged; its own URL keeps working (lib/nav navHubs, components/layout/hub-page).

import { HubPage } from "@/components/layout/hub-page";
import DtDashboardPage from "@/app/dt-dashboard/page";
import DtPurchasesPage from "@/app/dt-purchases/page";
import DtRefillsPage from "@/app/dt-refills/page";

export default function HubDtPage() {
  return <HubPage href="/hub/dt" components={{ "dashboard": DtDashboardPage, "purchases": DtPurchasesPage, "refills": DtRefillsPage }} />;
}
