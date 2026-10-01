"use client";

// INTENT pay-ins — the INTENT sub-module of Pay-in Flows (components/payin/flow-module).

import { FlowModule } from "@/components/payin/flow-module";

export default function Page() {
  return <FlowModule flow="INTENT" />;
}
