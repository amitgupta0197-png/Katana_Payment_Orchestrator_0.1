"use client";

// P2P dashboard (components/flows/p2p-dashboard). STAFF ONLY: the API (/api/flows/p2p) refuses anyone else.
// Suspense: the page reads ?mode= and ?banker= from the URL.

import { Suspense } from "react";
import { P2pFlowDashboard } from "@/components/flows/p2p-dashboard";

export default function Page() {
  return <Suspense fallback={null}><P2pFlowDashboard /></Suspense>;
}
