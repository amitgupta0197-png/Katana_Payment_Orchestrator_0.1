"use client";

// L1 — Risk cockpit. Tabbed (Chargebacks / Velocity rules / Blacklist),
// each kind in its own DataView with appropriate filters + search.

import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, ListChecks, Ban, Activity } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataView } from "@/components/world-class/data-view";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Chargeback { id: string; merchant_id: string; amount: number; reason_code: string; status: string; opened_at: string }
interface Rule { id: string; name: string; kind: string; window_seconds: number; cap: number; enabled: boolean }
interface Blacklist { id: string; kind: string; value: string; reason: string; created_at: string }

export default function RiskPage() {
  const cb = useQuery({
    queryKey: ["risk", "chargebacks"],
    queryFn: async () => (await fetch(`/api/risk?kind=chargebacks`).then((r) => r.json())) as { items: Chargeback[] },
  });
  const rules = useQuery({
    queryKey: ["risk", "rules"],
    queryFn: async () => (await fetch(`/api/risk?kind=rules`).then((r) => r.json())) as { items: Rule[] },
  });
  const bl = useQuery({
    queryKey: ["risk", "blacklist"],
    queryFn: async () => (await fetch(`/api/risk?kind=blacklist`).then((r) => r.json())) as { items: Blacklist[] },
  });

  const cbRows = cb.data?.items ?? [];
  const ruleRows = rules.data?.items ?? [];
  const blRows = bl.data?.items ?? [];

  const cbCols: Column<Chargeback>[] = [
    { key: "id", header: "Case", render: (r) => <span className="font-mono text-xs">{r.id?.slice(0, 8)}</span> },
    { key: "merchant_id", header: "Branch" },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount)}</span> },
    { key: "reason_code", header: "Reason", render: (r) => <Badge variant="warning">{r.reason_code}</Badge> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "opened_at", header: "Opened", render: (r) => <span className="text-xs">{formatDateTime(r.opened_at)}</span> },
  ];
  const ruleCols: Column<Rule>[] = [
    { key: "name", header: "Name" },
    { key: "kind", header: "Kind", render: (r) => <Badge variant="brand">{r.kind}</Badge> },
    { key: "window_seconds", header: "Window (s)", render: (r) => <span className="tabular-nums">{r.window_seconds}</span> },
    { key: "cap", header: "Cap", render: (r) => <span className="tabular-nums">{r.cap}</span> },
    { key: "enabled", header: "On?", render: (r) => r.enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];
  const blCols: Column<Blacklist>[] = [
    { key: "kind", header: "Kind", render: (r) => <Badge variant="danger">{r.kind}</Badge> },
    { key: "value", header: "Value", render: (r) => <span className="font-mono text-xs">{r.value}</span> },
    { key: "reason", header: "Reason" },
    { key: "created_at", header: "Added", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="Risk & velocity" description="Velocity rules, blacklist, chargebacks (PRODUCT_VISION §3.9)." icon={ShieldAlert} />
      <Tabs defaultValue="chargebacks">
        <TabsList>
          <TabsTrigger value="chargebacks"><Activity className="h-3.5 w-3.5" /> Chargebacks
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{cbRows.length}</span>
          </TabsTrigger>
          <TabsTrigger value="rules"><ListChecks className="h-3.5 w-3.5" /> Velocity rules
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{ruleRows.length}</span>
          </TabsTrigger>
          <TabsTrigger value="blacklist"><Ban className="h-3.5 w-3.5" /> Blacklist
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{blRows.length}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="chargebacks">
          <DataView rows={cbRows} columns={cbCols} rowKey={(r) => r.id} loading={cb.isLoading}
            search={{ placeholder: "Search by branch / reason…", fields: ["merchant_id", "reason_code", "status"] }}
            filters={[
              { key: "open",     label: "Open",     predicate: (r: Chargeback) => r.status !== "WON" && r.status !== "LOST" && r.status !== "EXPIRED" },
              { key: "won",      label: "Won",      predicate: (r: Chargeback) => r.status === "WON" },
              { key: "lost",     label: "Lost",     predicate: (r: Chargeback) => r.status === "LOST" },
            ]}
            savedViewKey="risk-cb" refresh={() => cb.refetch()}
            emptyTitle="No chargebacks" />
        </TabsContent>
        <TabsContent value="rules">
          <DataView rows={ruleRows} columns={ruleCols} rowKey={(r) => r.id} loading={rules.isLoading}
            search={{ placeholder: "Search by rule name…", fields: ["name", "kind"] }}
            filters={[
              { key: "on",  label: "On",  predicate: (r: Rule) => r.enabled },
              { key: "off", label: "Off", predicate: (r: Rule) => !r.enabled },
            ]}
            savedViewKey="risk-rules" refresh={() => rules.refetch()}
            emptyTitle="No velocity rules" emptyDescription="Add rules to throttle suspicious traffic per merchant / per method." />
        </TabsContent>
        <TabsContent value="blacklist">
          <DataView rows={blRows} columns={blCols} rowKey={(r) => r.id} loading={bl.isLoading}
            search={{ placeholder: "Search by value / reason…", fields: ["kind", "value", "reason"] }}
            savedViewKey="risk-bl" refresh={() => bl.refetch()}
            emptyTitle="No blacklist entries" />
        </TabsContent>
      </Tabs>
    </>
  );
}
