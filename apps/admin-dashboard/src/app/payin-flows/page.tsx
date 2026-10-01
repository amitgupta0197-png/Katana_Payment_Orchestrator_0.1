"use client";

// Pay-in Flows — the bifurcation of merchants and bankers by Katana pay-in flow: P2P, Intent
// or Both. This is where a flow is selected; the P2P and Intent sub-modules show each flow's
// own merchants, bankers and orders.

import Link from "next/link";
import { ArrowLeftRight, ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { FlowBankersTable, FlowMerchantsTable, useFlows } from "@/components/payin/flow-lists";
import { PAYIN_FLOW_HINT } from "@/lib/payin-flow";

export default function PayinFlowsPage() {
  const q = useFlows();
  const c = q.data?.counts;
  const n = (k: "P2P" | "INTENT" | "BOTH" | "UNSET") => (c ? `${c.merchants[k]} merchants · ${c.bankers[k]} bankers` : "");

  return (
    <>
      <PageHeader title="Pay-in Flows" icon={ArrowLeftRight}
        description="Which Katana pay-in flow each merchant is on: P2P, Intent or Both. A banker takes its merchant's flow unless it has its own." />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiTile label="P2P" value={c ? c.bankers.P2P : "—"} sublabel={n("P2P")} loading={q.isLoading} />
        <KpiTile label="Intent" value={c ? c.bankers.INTENT : "—"} sublabel={n("INTENT")} loading={q.isLoading} />
        <KpiTile label="Both" value={c ? c.bankers.BOTH : "—"} sublabel={n("BOTH")} loading={q.isLoading} variant="success" />
        <KpiTile label="Not selected" value={c ? c.bankers.UNSET : "—"} sublabel={n("UNSET")} loading={q.isLoading} variant={c && c.bankers.UNSET > 0 ? "warning" : "default"} />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        {([["P2P", "/payin-flows/p2p", PAYIN_FLOW_HINT.P2P], ["Intent", "/payin-flows/intent", PAYIN_FLOW_HINT.INTENT]] as const).map(([label, href, hint]) => (
          <Link key={href} href={href}>
            <Card className="transition-colors hover:border-[color:var(--color-brand)]">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base">{label} pay-ins</CardTitle>
                <ArrowRight className="h-4 w-4 text-[color:var(--color-text-muted)]" />
              </CardHeader>
              <CardContent className="text-sm text-[color:var(--color-text-muted)]">{hint} Open its orders, merchants and bankers.</CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {q.isError && <div className="mb-4 text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</div>}

      <Tabs defaultValue="merchants">
        <TabsList>
          <TabsTrigger value="merchants">Merchants ({q.data?.merchants.length ?? 0})</TabsTrigger>
          <TabsTrigger value="bankers">Bankers ({q.data?.bankers.length ?? 0})</TabsTrigger>
        </TabsList>
        <TabsContent value="merchants" className="mt-4">
          <FlowMerchantsTable rows={q.data?.merchants ?? []} loading={q.isLoading} refresh={() => q.refetch()} viewKey="payin-flows-merchants" showFilters />
        </TabsContent>
        <TabsContent value="bankers" className="mt-4">
          <FlowBankersTable rows={q.data?.bankers ?? []} loading={q.isLoading} refresh={() => q.refetch()} viewKey="payin-flows-bankers" showFilters />
        </TabsContent>
      </Tabs>
    </>
  );
}
