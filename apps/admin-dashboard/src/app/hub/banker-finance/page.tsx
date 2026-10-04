"use client";

// Banker finance hub: /merchant-wallet, /fund, /branch-settlements, /collections as tabs (?tab=). Each tab is the existing
// page, unchanged; its own URL keeps working (lib/nav navHubs, components/layout/hub-page).

import { HubPage } from "@/components/layout/hub-page";
import MerchantWalletPage from "@/app/merchant-wallet/page";
import FundPage from "@/app/fund/page";
import BranchSettlementsPage from "@/app/branch-settlements/page";
import CollectionsPage from "@/app/collections/page";

export default function HubBankerFinancePage() {
  return <HubPage href="/hub/banker-finance" components={{ "wallet": MerchantWalletPage, "fund": FundPage, "settlements": BranchSettlementsPage, "collections": CollectionsPage }} />;
}
