"use client";

// Security & keys hub: /admin/api-keys, /admin/tokens, /security, /admin/webhooks as tabs (?tab=). Each tab is the existing
// page, unchanged; its own URL keeps working (lib/nav navHubs, components/layout/hub-page).

import { HubPage } from "@/components/layout/hub-page";
import AdminApiKeysPage from "@/app/admin/api-keys/page";
import AdminTokensPage from "@/app/admin/tokens/page";
import SecurityPage from "@/app/security/page";
import AdminWebhooksPage from "@/app/admin/webhooks/page";

export default function HubSecurityPage() {
  return <HubPage href="/hub/security" components={{ "api-keys": AdminApiKeysPage, "vault": AdminTokensPage, "mfa": SecurityPage, "webhooks": AdminWebhooksPage }} />;
}
