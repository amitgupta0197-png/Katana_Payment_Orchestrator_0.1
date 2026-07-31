"use client";

// L1 — PG adapters. Tabbed (Providers / Credentials).

import { useQuery } from "@tanstack/react-query";
import { Network, KeyRound } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataView } from "@/components/world-class/data-view";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Provider { id: string; code: string; name: string; mdr_bps: number; enabled: boolean; health: string; success_rate_bps: number; created_at: string }
interface Credential { id: string; provider: string; env: string; active: boolean; created_at: string }

export default function PgAdapterPage() {
  const q = useQuery({
    queryKey: ["pg-adapter"],
    queryFn: async () => (await fetch("/api/pg-adapter").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { providers: Provider[]; credentials: Credential[] },
  });
  const providers = q.data?.providers ?? [];
  const creds = q.data?.credentials ?? [];

  const pCols: Column<Provider>[] = [
    { key: "code", header: "Code", render: (r) => <Badge variant="brand">{r.code}</Badge> },
    { key: "name", header: "Name" },
    { key: "mdr_bps", header: "MDR (bps)", render: (r) => <span className="tabular-nums">{r.mdr_bps}</span> },
    { key: "health", header: "Health", render: (r) => <Badge variant={statusVariant(r.health)}>{r.health}</Badge> },
    { key: "success_rate_bps", header: "Success %", render: (r) => <span className="tabular-nums">{(r.success_rate_bps / 100).toFixed(2)}%</span> },
    { key: "enabled", header: "On?", render: (r) => r.enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];
  const cCols: Column<Credential>[] = [
    { key: "provider", header: "Provider", render: (r) => <Badge variant="brand">{r.provider}</Badge> },
    { key: "env", header: "Env" },
    { key: "active", header: "Active", render: (r) => r.active ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
    { key: "created_at", header: "Created", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="PG adapters" description="Pay-in gateway adapter pool — providers + per-env credentials." icon={Network} />
      <Tabs defaultValue="providers">
        <TabsList>
          <TabsTrigger value="providers"><Network className="h-3.5 w-3.5" /> Providers
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{providers.length}</span>
          </TabsTrigger>
          <TabsTrigger value="creds"><KeyRound className="h-3.5 w-3.5" /> Credentials
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{creds.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="providers">
          <DataView rows={providers} columns={pCols} rowKey={(r) => r.id} loading={q.isLoading}
            search={{ placeholder: "Search by code / name…", fields: ["code", "name"] }}
            filters={[
              { key: "on",       label: "On",          predicate: (r: Provider) => r.enabled },
              { key: "off",      label: "Off",         predicate: (r: Provider) => !r.enabled },
              { key: "degraded", label: "Degraded",    predicate: (r: Provider) => r.health === "DEGRADED" || r.health === "WARN" },
              { key: "low-sr",   label: "Success <95%", predicate: (r: Provider) => r.success_rate_bps < 9500 },
            ]}
            savedViewKey="pg-providers" refresh={() => q.refetch()}
            emptyTitle="No PG providers" />
        </TabsContent>
        <TabsContent value="creds">
          <DataView rows={creds} columns={cCols} rowKey={(r) => r.id}
            search={{ placeholder: "Search by provider / env…", fields: ["provider", "env"] }}
            filters={[
              { key: "active",   label: "Active",   predicate: (r: Credential) => r.active },
              { key: "inactive", label: "Inactive", predicate: (r: Credential) => !r.active },
            ]}
            savedViewKey="pg-creds"
            emptyTitle="No credentials" />
        </TabsContent>
      </Tabs>
    </>
  );
}
