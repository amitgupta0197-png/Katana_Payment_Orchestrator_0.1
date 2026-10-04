"use client";

// Payout dashboard (components/flows/payout-dashboard). STAFF ONLY: the API (/api/flows/payout) refuses anyone else.
// Suspense: the page reads ?mode= and ?banker= from the URL.

import { Suspense } from "react";
import { PayoutFlowDashboard } from "@/components/flows/payout-dashboard";

export default function Page() {
  return <Suspense fallback={null}><PayoutFlowDashboard /></Suspense>;
}
