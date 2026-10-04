"use client";

// Platform ops hub: /admin/noc, /admin/hardening as tabs (?tab=). Each tab is the existing
// page, unchanged; its own URL keeps working (lib/nav navHubs, components/layout/hub-page).

import { HubPage } from "@/components/layout/hub-page";
import AdminNocPage from "@/app/admin/noc/page";
import AdminHardeningPage from "@/app/admin/hardening/page";

export default function HubPlatformOpsPage() {
  return <HubPage href="/hub/platform-ops" components={{ "noc": AdminNocPage, "hardening": AdminHardeningPage }} />;
}
