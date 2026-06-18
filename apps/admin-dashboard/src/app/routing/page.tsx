"use client";

// L1 — routing engine. Tabbed (Rules / Rails) with filter chips per tab.

import { useQuery } from "@tanstack/react-query";
import { Workflow, ListChecks, Network } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataView } from "@/components/world-class/data-view";

interface Rule { id: string; name: string; priority: number; method: string; min_amount?: number; max_amount?: number; enabled: boolean; created_at: string }
interface Rail { id: string; provider: string; method: string; direction: string; enabled: boolean; weight: number; mdr_bps: number }

export default function RoutingPage() {
  const q = useQuery({
    queryKey: ["routing"],
    queryFn: async () => (await fetch("/api/routing").then((r) => r.json())) as { rules: Rule[]; rails: Rail[] },
  });
  const rules = q.data?.rules ?? [];
  const rails = q.data?.rails ?? [];

  const ruleCols: Column<Rule>[] = [
    { key: "priority", header: "Pri", render: (r) => <span className="tabular-nums">{r.priority}</span> },
    { key: "name", header: "Name" },
    { key: "method", header: "Method", render: (r) => <Badge variant="brand">{r.method}</Badge> },
    { key: "min_amount", header: "Range", render: (r) => <span className="tabular-nums">{r.min_amount ?? 0}—{r.max_amount ?? "∞"}</span> },
    { key: "enabled", header: "On?", render: (r) => r.enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];
  const railCols: Column<Rail>[] = [
    { key: "provider", header: "Provider", render: (r) => <Badge variant="brand">{r.provider}</Badge> },
    { key: "method", header: "Method" },
    { key: "direction", header: "Dir", render: (r) => <Badge variant="info">{r.direction}</Badge> },
    { key: "weight", header: "Weight", render: (r) => <span className="tabular-nums">{r.weight}</span> },
    { key: "mdr_bps", header: "MDR (bps)", render: (r) => <span className="tabular-nums">{r.mdr_bps}</span> },
    { key: "enabled", header: "On?", render: (r) => r.enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];

  return (
    <>
      <PageHeader title="Routing engine" description="Rule order + rail catalogue + health probe results." icon={Workflow} />
      <Tabs defaultValue="rules">
        <TabsList>
          <TabsTrigger value="rules"><ListChecks className="h-3.5 w-3.5" /> Rules
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{rules.length}</span>
          </TabsTrigger>
          <TabsTrigger value="rails"><Network className="h-3.5 w-3.5" /> Rails
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{rails.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="rules">
          <DataView rows={rules} columns={ruleCols} rowKey={(r) => r.id} loading={q.isLoading}
            search={{ placeholder: "Search by rule name / method…", fields: ["name", "method"] }}
            filters={[
              { key: "on",  label: "On",  predicate: (r: Rule) => r.enabled },
              { key: "off", label: "Off", predicate: (r: Rule) => !r.enabled },
            ]}
            savedViewKey="routing-rules" refresh={() => q.refetch()}
            emptyTitle="No routing rules" />
        </TabsContent>
        <TabsContent value="rails">
          <DataView rows={rails} columns={railCols} rowKey={(r) => r.id}
            search={{ placeholder: "Search by provider / method…", fields: ["provider", "method"] }}
            filters={[
              { key: "on",     label: "On",     predicate: (r: Rail) => r.enabled },
              { key: "off",    label: "Off",    predicate: (r: Rail) => !r.enabled },
              { key: "payin",  label: "Pay-in", predicate: (r: Rail) => r.direction === "payin" },
              { key: "payout", label: "Payout", predicate: (r: Rail) => r.direction === "payout" },
            ]}
            savedViewKey="routing-rails"
            emptyTitle="No rails" />
        </TabsContent>
      </Tabs>
    </>
  );
}
