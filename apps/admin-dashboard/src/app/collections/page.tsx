"use client";

import { useQuery } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
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
  const cols: Column<VA>[] = [
    { key: "counterparty", header: "Merchant" },
    { key: "bank", header: "Bank" },
    { key: "va_account_no", header: "Account", render: (r) => <span className="font-mono text-xs">{r.va_account_no}</span> },
    { key: "va_ifsc", header: "IFSC" },
    { key: "va_upi_vpa", header: "UPI VPA", render: (r) => r.va_upi_vpa || "—" },
    { key: "purpose", header: "Purpose" },
    { key: "active", header: "Active", render: (r) => r.active ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];
  return (
    <>
      <PageHeader title="Collections (VA)" description="Virtual-account mappings per merchant." icon={Inbox} />
      <Card><CardHeader><CardTitle>{(q.data?.accounts ?? []).length} VAs</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.accounts ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No virtual accounts." /></CardContent>
      </Card>
    </>
  );
}
