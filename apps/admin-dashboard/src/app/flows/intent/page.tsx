"use client";

// Intent dashboard (components/flows/intent-dashboard). STAFF ONLY: the API (/api/flows/intent) refuses anyone else.
// Suspense: the page reads ?mode= and ?banker= from the URL.

import { Suspense } from "react";
import { IntentFlowDashboard } from "@/components/flows/intent-dashboard";

export default function Page() {
  return <Suspense fallback={null}><IntentFlowDashboard /></Suspense>;
}
