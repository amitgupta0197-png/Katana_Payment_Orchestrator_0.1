"use client";

// FIFO hub: /fifo-dashboard, /fifo-reports, /fifo-reconciliation, /fifo-settlements as tabs (?tab=). Each tab is the existing
// page, unchanged; its own URL keeps working (lib/nav navHubs, components/layout/hub-page).

import { HubPage } from "@/components/layout/hub-page";
import FifoDashboardPage from "@/app/fifo-dashboard/page";
import FifoReportsPage from "@/app/fifo-reports/page";
import FifoReconciliationPage from "@/app/fifo-reconciliation/page";
import FifoSettlementsPage from "@/app/fifo-settlements/page";

export default function HubFifoPage() {
  return <HubPage href="/hub/fifo" components={{ "dashboard": FifoDashboardPage, "reports": FifoReportsPage, "reconciliation": FifoReconciliationPage, "settlements": FifoSettlementsPage }} />;
}
