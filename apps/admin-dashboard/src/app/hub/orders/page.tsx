"use client";

// Orders hub: /payin-order, /payout-order, /summary as tabs (?tab=). Each tab is the existing
// page, unchanged; its own URL keeps working (lib/nav navHubs, components/layout/hub-page).

import { HubPage } from "@/components/layout/hub-page";
import PayinOrderPage from "@/app/payin-order/page";
import PayoutOrderPage from "@/app/payout-order/page";
import SummaryPage from "@/app/summary/page";

export default function HubOrdersPage() {
  return <HubPage href="/hub/orders" components={{ "payin": PayinOrderPage, "payout": PayoutOrderPage, "summary": SummaryPage }} />;
}
