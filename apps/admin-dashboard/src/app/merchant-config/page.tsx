"use client";

// L1 — merchant config. Tabbed (Flags / Overrides), each in its own
// DataView with search + filters.

import { useQuery } from "@tanstack/react-query";
import { Sliders, Flag as FlagIcon, GitPullRequest } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataView } from "@/components/world-class/data-view";

interface Flag { key: string; description: string; kind: string; default_value: string; archived: boolean }
interface Override { id: string; flag_key: string; scope_kind: string; scope_value: string; value: string; created_at: string }

export default function MerchantConfigPage() {
  const q = useQuery({
    queryKey: ["merchant-config"],
    queryFn: async () => (await fetch("/api/merchant-config").then((r) => r.json())) as { flags: Flag[]; overrides: Override[] },
  });
  const flags = q.data?.flags ?? [];
  const overrides = q.data?.overrides ?? [];

  const flagCols: Column<Flag>[] = [
    { key: "key", header: "Flag", render: (r) => <span className="font-mono text-xs">{r.key}</span> },
    { key: "kind", header: "Kind", render: (r) => <Badge variant="brand">{r.kind}</Badge> },
    { key: "default_value", header: "Default", render: (r) => <span className="font-mono text-xs">{r.default_value}</span> },
    { key: "description", header: "Description" },
    { key: "archived", header: "Archived", render: (r) => r.archived ? <Badge variant="warning">yes</Badge> : <Badge variant="success">no</Badge> },
  ];
  const overrideCols: Column<Override>[] = [
    { key: "flag_key", header: "Flag", render: (r) => <span className="font-mono text-xs">{r.flag_key}</span> },
    { key: "scope_kind", header: "Scope", render: (r) => <Badge variant="info">{r.scope_kind}</Badge> },
    { key: "scope_value", header: "Subject", render: (r) => <span className="font-mono text-xs">{r.scope_value}</span> },
    { key: "value", header: "Value", render: (r) => <Badge>{r.value}</Badge> },
  ];

  return (
    <>
      <PageHeader title="Merchant config" description="Feature-flag overrides per merchant (PRODUCT_VISION §3.11)." icon={Sliders} />
      <Tabs defaultValue="flags">
        <TabsList>
          <TabsTrigger value="flags"><FlagIcon className="h-3.5 w-3.5" /> Flags
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{flags.length}</span>
          </TabsTrigger>
          <TabsTrigger value="overrides"><GitPullRequest className="h-3.5 w-3.5" /> Overrides
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{overrides.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="flags">
          <DataView rows={flags} columns={flagCols} rowKey={(r) => r.key} loading={q.isLoading}
            search={{ placeholder: "Search by key or description…", fields: ["key", "description"] }}
            filters={[
              { key: "live",     label: "Live",     predicate: (r: Flag) => !r.archived },
              { key: "archived", label: "Archived", predicate: (r: Flag) => r.archived },
            ]}
            savedViewKey="merchant-config-flags" refresh={() => q.refetch()}
            emptyTitle="No flags defined" />
        </TabsContent>
        <TabsContent value="overrides">
          <DataView rows={overrides} columns={overrideCols} rowKey={(r) => r.id}
            search={{ placeholder: "Search by flag / subject…", fields: ["flag_key", "scope_value"] }}
            savedViewKey="merchant-config-overrides"
            emptyTitle="No overrides yet" emptyDescription="Per-merchant overrides land here once set." />
        </TabsContent>
      </Tabs>
    </>
  );
}
