"use client";

// P2P pay-ins — the P2P sub-module of Pay-in Flows (components/payin/flow-module).

import { FlowModule } from "@/components/payin/flow-module";

export default function Page() {
  return <FlowModule flow="P2P" />;
}
