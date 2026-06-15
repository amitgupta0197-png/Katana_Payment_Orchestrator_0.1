"use client";

import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import type { Integration } from "@/lib/integrations-catalog";
import { INTEGRATION_CATEGORIES } from "@/lib/integrations-catalog";

const STATUS_VARIANT: Record<string, "success" | "warning" | "default"> = {
  implemented: "success", scaffold: "warning", not_started: "default",
};

export default function IntegrationsPage() {
  const q = useQuery({
    queryKey: ["integrations"],
    queryFn: async () => (await fetch("/api/integrations").then((r) => r.json())) as { integrations: Integration[] },
  });
  const cols: Column<Integration>[] = [
    { key: "code", header: "Code" },
    { key: "name", header: "Name" },
    { key: "category", header: "Category" },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>{r.status}</Badge> },
    { key: "secret_ref", header: "Vault ref", render: (r) => r.secret_ref ? <span className="font-mono text-xs">{r.secret_ref}</span> : "—" },
    { key: "webhook_url", header: "Webhook", render: (r) => r.webhook_url ? <span className="font-mono text-xs">{r.webhook_url}</span> : "—" },
  ];

  const all = q.data?.integrations ?? [];
  return (
    <>
      <PageHeader title="Integrations" description="Single source of truth for every external integration (PRODUCT_VISION §3.4)." icon={KeyRound} />
      {INTEGRATION_CATEGORIES.map((cat) => {
        const rows = all.filter((i) => i.category === cat);
        if (!rows.length) return null;
        return (
          <Card key={cat} className="mb-4">
            <CardHeader><CardTitle>{cat} ({rows.length})</CardTitle></CardHeader>
            <CardContent><DataTable columns={cols} rows={rows} rowKey={(r) => r.code} emptyState="None." /></CardContent>
          </Card>
        );
      })}
    </>
  );
}
