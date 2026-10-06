"use client";

// Unmatched payments, every banker (staff). ?banker=CODE shows one banker (the "Needs attention" link).

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { HandCoins } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { UnmatchedPayments } from "@/components/payin/unmatched-payments";

function Inner() {
  const banker = useSearchParams().get("banker");
  return (
    <div>
      <PageHeader title="Unmatched payments" icon={HandCoins}
        description={banker ? `Money ${banker} received with no order. Link each one, or mark it as not an order payment.` : "Money bankers received with no order. Links asked for by merchants or bankers wait here for approval."} />
      <UnmatchedPayments banker={banker} />
    </div>
  );
}

export default function Page() {
  return <Suspense><Inner /></Suspense>;
}
