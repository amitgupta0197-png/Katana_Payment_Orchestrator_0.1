"use client";

// L1 — reporting. Tabbed (Daily / Recent facts) with KPI strip.

import { useQuery } from "@tanstack/react-query";
import { BarChart3, CalendarDays, Activity } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataView } from "@/components/world-class/data-view";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface DailyRow { merchant_id: string; kind: string; status: string; day: string; currency: string; txn_count: number; gross_amount: number; fee_amount: number }
interface Fact { id: string; merchant_id: string; txn_id: string; kind: string; rail: string; method: string; amount: number; fee: number; currency: string; status: string; occurred_at: string }

export default function ReportingPage() {
  const q = useQuery({
    queryKey: ["reporting"],
    queryFn: async () => (await fetch("/api/reporting").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { daily: DailyRow[]; facts_recent: Fact[] },
  });
  const daily = q.data?.daily ?? [];
  const facts = q.data?.facts_recent ?? [];
  const totalGross = daily.reduce((s, d) => s + Number(d.gross_amount || 0), 0);
  const totalFee = daily.reduce((s, d) => s + Number(d.fee_amount || 0), 0);

  const dCols: Column<DailyRow>[] = [
    { key: "day", header: "Day", render: (r) => <span className="text-xs">{formatDateTime(r.day)}</span> },
    { key: "merchant_id", header: "Merchant" },
    { key: "kind", header: "Kind", render: (r) => <Badge variant="brand">{r.kind}</Badge> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "txn_count", header: "Count", render: (r) => <span className="tabular-nums">{r.txn_count}</span> },
    { key: "gross_amount", header: "Gross", render: (r) => <span className="tabular-nums">{formatAmount(r.gross_amount, r.currency)}</span> },
    { key: "fee_amount", header: "Fee", render: (r) => <span className="tabular-nums">{formatAmount(r.fee_amount, r.currency)}</span> },
  ];
  const fCols: Column<Fact>[] = [
    { key: "occurred_at", header: "When", render: (r) => <span className="text-xs">{formatDateTime(r.occurred_at)}</span> },
    { key: "merchant_id", header: "Merchant" },
    { key: "kind", header: "Kind" },
    { key: "rail", header: "Rail" },
    { key: "method", header: "Method" },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency)}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
  ];

  return (
    <>
      <PageHeader title="Reporting" description="Daily merchant roll-ups + recent transaction facts (PRODUCT_VISION §3.11)." icon={BarChart3} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <KpiTile label="Daily rows" value={daily.length} loading={q.isLoading} />
        <KpiTile label="Total gross" value={formatAmount(totalGross)} loading={q.isLoading} />
        <KpiTile label="Total fees" value={formatAmount(totalFee)} loading={q.isLoading} />
      </div>
      <Tabs defaultValue="daily">
        <TabsList>
          <TabsTrigger value="daily"><CalendarDays className="h-3.5 w-3.5" /> Daily
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{daily.length}</span>
          </TabsTrigger>
          <TabsTrigger value="facts"><Activity className="h-3.5 w-3.5" /> Recent facts
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{facts.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="daily">
          <DataView rows={daily} columns={dCols} rowKey={(r) => `${r.merchant_id}|${r.day}|${r.kind}|${r.status}|${r.currency}`} loading={q.isLoading}
            search={{ placeholder: "Search by merchant / kind…", fields: ["merchant_id", "kind", "status"] }}
            savedViewKey="reporting-daily" refresh={() => q.refetch()}
            emptyTitle="No daily rows" />
        </TabsContent>
        <TabsContent value="facts">
          <DataView rows={facts} columns={fCols} rowKey={(r) => r.id}
            search={{ placeholder: "Search by merchant / rail / kind…", fields: ["merchant_id", "kind", "rail", "method"] }}
            savedViewKey="reporting-facts"
            emptyTitle="No fact rows" />
        </TabsContent>
      </Tabs>
    </>
  );
}
