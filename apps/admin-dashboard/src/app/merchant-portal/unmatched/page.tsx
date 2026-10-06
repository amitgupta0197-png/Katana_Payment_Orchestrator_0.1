"use client";

// Unmatched payments: money your bankers received with no order (components/payin/unmatched-payments).

import { UnmatchedPayments } from "@/components/payin/unmatched-payments";

export default function Page() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Unmatched payments</h1>
        <p className="text-sm text-[color:var(--color-text-muted)]">Money that arrived with no order. Tell Katana which order each one is for.</p>
      </div>
      <UnmatchedPayments />
    </div>
  );
}
