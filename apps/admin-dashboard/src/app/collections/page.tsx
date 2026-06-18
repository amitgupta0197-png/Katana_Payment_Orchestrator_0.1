"use client";

// L1 — virtual accounts. DataView with bank + active filter chips + search.

import { useQuery } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { formatDateTime } from "@/lib/utils";

interface VA {
  id: string; counterparty: string; bank: string; va_account_no: string;
  va_ifsc: string; va_upi_vpa: string; purpose: string; active: boolean; created_at: string;
}

export default function CollectionsPage() {
  const q = useQuery({
    queryKey: ["collections"],
    queryFn: async () => (await fetch("/api/collections/va").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { accounts: VA[] },
  });
  const rows = q.data?.accounts ?? [];
  const banks = Array.from(new Set(rows.map((v) => v.bank))).slice(0, 5);

  const cols: Column<VA>[] = [
    { key: "counterparty", header: "Merchant" },
    { key: "bank", header: "Bank", render: (r) => <Badge variant="brand">{r.bank}</Badge> },
    { key: "va_account_no", header: "Account", render: (r) => <span className="font-mono text-xs">{r.va_account_no}</span> },
    { key: "va_ifsc", header: "IFSC" },
    { key: "va_upi_vpa", header: "UPI VPA", render: (r) => r.va_upi_vpa || "—" },
    { key: "purpose", header: "Purpose" },
    { key: "active", header: "Active", render: (r) => r.active ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
    { key: "created_at", header: "Created", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="Collections (VA)" description="Virtual-account mappings per merchant." icon={Inbox} />
      <DataView rows={rows} columns={cols} rowKey={(r) => r.id} loading={q.isLoading}
        search={{ placeholder: "Search by merchant / VA / IFSC / VPA…", fields: ["counterparty", "va_account_no", "va_ifsc", "va_upi_vpa"] }}
        filters={[
          { key: "active",   label: "Active",   predicate: (r: VA) => r.active },
          { key: "inactive", label: "Inactive", predicate: (r: VA) => !r.active },
          ...banks.map((b) => ({ key: `b-${b}`, label: b, predicate: (r: VA) => r.bank === b })),
        ]}
        savedViewKey="collections" refresh={() => q.refetch()}
        emptyTitle="No virtual accounts" emptyDescription="Provision VAs from the bank-adapter cockpit to start collections." />
    </>
  );
}
