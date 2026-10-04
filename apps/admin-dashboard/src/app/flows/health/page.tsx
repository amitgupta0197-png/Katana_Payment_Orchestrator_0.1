"use client";

// Flow health dashboard (components/flows/health-dashboard). STAFF ONLY: the API (/api/flows/health) refuses anyone else.
// Suspense: the page reads ?mode= and ?banker= from the URL.

import { Suspense } from "react";
import { FlowHealthDashboard } from "@/components/flows/health-dashboard";

export default function Page() {
  return <Suspense fallback={null}><FlowHealthDashboard /></Suspense>;
}
