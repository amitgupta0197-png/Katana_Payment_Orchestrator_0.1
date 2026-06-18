"use client";

import { useQuery } from "@tanstack/react-query";
import { Sliders } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";

interface Flag { key: string; description: string; kind: string; default_value: string; archived: boolean }
interface Override { id: string; flag_key: string; scope_kind: string; scope_value: string; value: string; created_at: string }

export default function MerchantConfigPage() {
  const q = useQuery({
    queryKey: ["merchant-config"],
    queryFn: async () => (await fetch("/api/merchant-config").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { flags: Flag[]; overrides: Override[] },
  });

  const flagCols: Column<Flag>[] = [
    { key: "key", header: "Flag" },
    { key: "kind", header: "Kind" },
    { key: "default_value", header: "Default" },
    { key: "description", header: "Description" },
  ];
  const overrideCols: Column<Override>[] = [
    { key: "flag_key", header: "Flag" },
    { key: "scope_kind", header: "Scope" },
    { key: "scope_value", header: "Subject" },
    { key: "value", header: "Value", render: (r) => <Badge>{r.value}</Badge> },
  ];

  return (
    <>
      <PageHeader title="Merchant config" description="Feature-flag overrides per merchant (PRODUCT_VISION §3.11)." icon={Sliders} />
      <Card className="mb-4">
        <CardHeader><CardTitle>Feature flags ({(q.data?.flags ?? []).length})</CardTitle></CardHeader>
        <CardContent>
          <DataTable columns={flagCols} rows={q.data?.flags ?? []} loading={q.isLoading} rowKey={(r) => r.key} emptyState="No flags." />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Active overrides ({(q.data?.overrides ?? []).length})</CardTitle></CardHeader>
        <CardContent>
          <DataTable columns={overrideCols} rows={q.data?.overrides ?? []} rowKey={(r) => r.id} emptyState="No overrides." />
        </CardContent>
      </Card>
    </>
  );
}
