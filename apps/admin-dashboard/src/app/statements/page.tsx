"use client";

// Statements (admin) — download a transaction statement for any period, tenant-wide or
// narrowed to specific banker codes. Backed by /api/statements (SUPER_ADMIN/ADMIN/FINANCE).

import { useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DownloadStatement } from "@/components/statement/download-statement";

export default function StatementsPage() {
  // Typed, not picked from a list: an admin statement is usually pulled for a code someone
  // has quoted in a ticket, and the code set is large enough that a dropdown would be worse.
  const [codes, setCodes] = useState("");
  const trimmed = codes.trim();

  return (
    <>
      <PageHeader
        title="Statements"
        description="Download collections for any period as a CSV — Merchant Hosted Checkout, Gateway Hosted Checkout, or both."
        icon={FileSpreadsheet}
      />
      <DownloadStatement
        endpoint="/api/statements"
        description="Covers every banker unless you filter below. Times are IST; amounts are in rupees."
        extraParams={trimmed ? { codes: trimmed } : undefined}
      >
        <div className="mb-5">
          <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
            Banker codes <span className="font-normal normal-case tracking-normal">(optional, comma-separated)</span>
          </label>
          <input
            value={codes}
            onChange={(e) => setCodes(e.target.value)}
            placeholder="All bankers"
            className="h-9 w-full max-w-sm rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 text-sm text-[color:var(--color-text)]"
          />
        </div>
      </DownloadStatement>
    </>
  );
}
