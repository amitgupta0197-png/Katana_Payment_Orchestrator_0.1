"use client";

import { useQuery } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Tenant { id: string; parent_id: string; type: string; code: string; name: string; status: string; created_at: string }

export default function TenantsPage() {
  const q = useQuery({
    queryKey: ["tenants"],
    queryFn: async () => (await fetch("/api/tenants").then((r) => r.json())) as { tenants: Tenant[] },
  });
  const cols: Column<Tenant>[] = [
    { key: "code", header: "Code" },
    { key: "name", header: "Name" },
    { key: "type", header: "Type" },
    { key: "parent_id", header: "Parent", render: (r) => r.parent_id ? <span className="font-mono text-xs">{r.parent_id.slice(0,8)}…</span> : "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];
  return (
    <>
      <PageHeader title="Tenants" description="Multi-tenant management (PRODUCT_VISION §3.11)." icon={Globe} />
      <Card><CardHeader><CardTitle>{(q.data?.tenants ?? []).length} tenants</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.tenants ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No tenants." /></CardContent>
      </Card>
    </>
  );
}
