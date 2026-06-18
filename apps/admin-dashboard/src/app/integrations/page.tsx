"use client";

// L1 — integrations catalog. DataView with status + category chips + search.

import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { KpiTile } from "@/components/world-class/kpi-tile";
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
  const all = q.data?.integrations ?? [];
  const implemented = all.filter((i) => i.status === "implemented").length;
  const scaffold = all.filter((i) => i.status === "scaffold").length;
  const notStarted = all.filter((i) => i.status === "not_started").length;

  const cols: Column<Integration>[] = [
    { key: "code", header: "Code", render: (r) => <span className="font-mono text-xs">{r.code}</span> },
    { key: "name", header: "Name" },
    { key: "category", header: "Category", render: (r) => <Badge variant="brand">{r.category}</Badge> },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>{r.status}</Badge> },
    { key: "secret_ref", header: "Vault ref", render: (r) => r.secret_ref ? <span className="font-mono text-xs">{r.secret_ref}</span> : "—" },
    { key: "webhook_url", header: "Webhook", render: (r) => r.webhook_url ? <span className="font-mono text-xs">{r.webhook_url}</span> : "—" },
  ];

  return (
    <>
      <PageHeader title="Integrations" description="Single source of truth for every external integration (PRODUCT_VISION §3.4)." icon={KeyRound} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Total" value={all.length} loading={q.isLoading} />
        <KpiTile label="Implemented" value={implemented} variant="success" loading={q.isLoading} />
        <KpiTile label="Scaffold" value={scaffold} variant="warning" loading={q.isLoading} />
        <KpiTile label="Not started" value={notStarted} loading={q.isLoading} />
      </div>
      <DataView rows={all} columns={cols} rowKey={(r) => r.code} loading={q.isLoading}
        search={{ placeholder: "Search by code / name / category…", fields: ["code", "name", "category"] }}
        filters={[
          { key: "live",     label: "Implemented", predicate: (r: Integration) => r.status === "implemented" },
          { key: "scaffold", label: "Scaffold",    predicate: (r: Integration) => r.status === "scaffold" },
          { key: "todo",     label: "Not started", predicate: (r: Integration) => r.status === "not_started" },
          ...INTEGRATION_CATEGORIES.slice(0, 4).map((c) => ({ key: `c-${c}`, label: c, predicate: (r: Integration) => r.category === c })),
        ]}
        savedViewKey="integrations" refresh={() => q.refetch()}
        emptyTitle="No integrations registered" />
    </>
  );
}
