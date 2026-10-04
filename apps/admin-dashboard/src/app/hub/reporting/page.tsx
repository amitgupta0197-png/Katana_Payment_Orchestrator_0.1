"use client";

// Reporting hub: /statements, /reporting as tabs (?tab=). Each tab is the existing
// page, unchanged; its own URL keeps working (lib/nav navHubs, components/layout/hub-page).

import { HubPage } from "@/components/layout/hub-page";
import StatementsPage from "@/app/statements/page";
import ReportingPage from "@/app/reporting/page";

export default function HubReportingPage() {
  return <HubPage href="/hub/reporting" components={{ "statements": StatementsPage, "reporting": ReportingPage }} />;
}
