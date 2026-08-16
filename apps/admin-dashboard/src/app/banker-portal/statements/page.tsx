"use client";

// Banker Statements — download this banker's own transaction statement for a chosen
// period. Backed by /api/banker-portal/statement, scoped to the banker's code.

import { FileSpreadsheet } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DownloadStatement } from "@/components/statement/download-statement";

export default function BankerStatementsPage() {
  return (
    <>
      <PageHeader
        title="Statements"
        description="Download your collections for any period as a CSV — Merchant Hosted Checkout, Gateway Hosted Checkout, or both."
        icon={FileSpreadsheet}
      />
      <DownloadStatement
        endpoint="/api/banker-portal/statement"
        description="Covers the credits and orders booked under your banker code. Times are IST; amounts are in rupees."
      />
    </>
  );
}
