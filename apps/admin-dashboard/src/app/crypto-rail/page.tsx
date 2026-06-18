"use client";

// L1 — crypto rails. Tabbed (VASPs / Recent transfers).

import { useQuery } from "@tanstack/react-query";
import { Coins, ArrowLeftRight } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataView } from "@/components/world-class/data-view";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Vasp { id: string; code: string; name: string; kind: string; enabled: boolean; spread_bps: number; created_at: string }
interface Transfer { id: string; vasp_code: string; network: string; txid: string; amount: number; currency: string; status: string; created_at: string }

export default function CryptoRailPage() {
  const q = useQuery({
    queryKey: ["crypto-rail"],
    queryFn: async () => (await fetch("/api/crypto-rail").then((r) => r.json())) as { vasps: Vasp[]; recent_transfers: Transfer[] },
  });
  const vasps = q.data?.vasps ?? [];
  const transfers = q.data?.recent_transfers ?? [];

  const vCols: Column<Vasp>[] = [
    { key: "code", header: "Code", render: (r) => <Badge variant="brand">{r.code}</Badge> },
    { key: "name", header: "Name" },
    { key: "kind", header: "Kind", render: (r) => <Badge variant="info">{r.kind}</Badge> },
    { key: "spread_bps", header: "Spread (bps)", render: (r) => <span className="tabular-nums">{r.spread_bps}</span> },
    { key: "enabled", header: "On?", render: (r) => r.enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];
  const tCols: Column<Transfer>[] = [
    { key: "vasp_code", header: "VASP", render: (r) => <Badge variant="brand">{r.vasp_code}</Badge> },
    { key: "network", header: "Network" },
    { key: "txid", header: "TXID", render: (r) => <span className="font-mono text-xs">{r.txid?.slice(0, 16)}…</span> },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency)}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "When", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="Crypto rails" description="VASP adapter pool — Binance OTC, OKX, Bitget, OnMeta, Transak…" icon={Coins} />
      <Tabs defaultValue="vasps">
        <TabsList>
          <TabsTrigger value="vasps"><Coins className="h-3.5 w-3.5" /> VASPs
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{vasps.length}</span>
          </TabsTrigger>
          <TabsTrigger value="transfers"><ArrowLeftRight className="h-3.5 w-3.5" /> Transfers
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{transfers.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="vasps">
          <DataView rows={vasps} columns={vCols} rowKey={(r) => r.id} loading={q.isLoading}
            search={{ placeholder: "Search by code / name / kind…", fields: ["code", "name", "kind"] }}
            filters={[
              { key: "on",  label: "On",  predicate: (r: Vasp) => r.enabled },
              { key: "off", label: "Off", predicate: (r: Vasp) => !r.enabled },
            ]}
            savedViewKey="crypto-vasps" refresh={() => q.refetch()}
            emptyTitle="No VASPs configured" />
        </TabsContent>
        <TabsContent value="transfers">
          <DataView rows={transfers} columns={tCols} rowKey={(r) => r.id}
            search={{ placeholder: "Search by VASP / network / TXID…", fields: ["vasp_code", "network", "txid"] }}
            filters={[
              { key: "confirmed", label: "Confirmed", predicate: (r: Transfer) => r.status === "CONFIRMED" || r.status === "COMPLETED" },
              { key: "pending",   label: "Pending",   predicate: (r: Transfer) => r.status === "PENDING" },
              { key: "failed",    label: "Failed",    predicate: (r: Transfer) => r.status === "FAILED" },
            ]}
            savedViewKey="crypto-transfers"
            emptyTitle="No transfers yet" />
        </TabsContent>
      </Tabs>
    </>
  );
}
