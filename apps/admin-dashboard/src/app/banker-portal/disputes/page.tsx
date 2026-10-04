"use client";

// The banker's chargebacks: what its bank or the payment processor charged back on its Katana Pay
// pay-ins, matched to the original payment in its own channel, and what was debited under the
// merchant's terms. Read-only; Katana staff record and decide them (components/chargebacks).

import { ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { ChargebacksList } from "@/components/chargebacks/chargebacks-list";

export default function DisputesPage() {
  return (
    <>
      <PageHeader title="Chargebacks" description="Chargebacks on your payments, matched to the original payment in its own channel." icon={ShieldAlert} />
      <ChargebacksList />
    </>
  );
}
