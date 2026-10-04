"use client";

// Adapters hub: /pg-adapter, /bank-adapter as tabs (?tab=). Each tab is the existing
// page, unchanged; its own URL keeps working (lib/nav navHubs, components/layout/hub-page).

import { HubPage } from "@/components/layout/hub-page";
import PgAdapterPage from "@/app/pg-adapter/page";
import BankAdapterPage from "@/app/bank-adapter/page";

export default function HubAdaptersPage() {
  return <HubPage href="/hub/adapters" components={{ "pg": PgAdapterPage, "bank": BankAdapterPage }} />;
}
