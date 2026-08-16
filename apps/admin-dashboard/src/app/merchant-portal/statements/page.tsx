"use client";

// Provider Statements — download a transaction statement for a chosen period, across
// both checkout channels. Backed by /api/merchant-portal/statement, scoped to the
// provider's own bankers.

import { FileSpreadsheet } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DownloadStatement } from "@/components/statement/download-statement";

export default function ProviderStatementsPage() {
  return (
    <>
      <PageHeader
        title="Statements"
        description="Download your collections for any period as a CSV — Merchant Hosted Checkout, Gateway Hosted Checkout, or both."
        icon={FileSpreadsheet}
      />
      <DownloadStatement
        endpoint="/api/merchant-portal/statement"
        description="Covers every banker assigned to you. Times are IST; amounts are in rupees."
      />
    </>
  );
}
