"use client";

// L1 — merchant wallets. DataView + currency chips + KPI strip.

import { useQuery } from "@tanstack/react-query";
import { Wallet } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { formatAmount } from "@/lib/utils";

interface Balance { merchant_id: string; currency: string; balance: number }

export default function MerchantWalletPage() {
  const q = useQuery({
    queryKey: ["balances"],
    queryFn: async () => (await fetch("/api/ledger/balance").then((r) => r.json())) as { balances: Balance[] },
  });
  const rows = q.data?.balances ?? [];
  const currencies = Array.from(new Set(rows.map((r) => r.currency)));
  const totalAll = rows.reduce((s, b) => s + Number(b.balance || 0), 0);

  const cols: Column<Balance>[] = [
    { key: "merchant_id", header: "Merchant" },
    { key: "currency", header: "Currency", render: (r) => <Badge variant="brand">{r.currency}</Badge> },
    { key: "balance", header: "Balance", render: (r) => <span className="tabular-nums font-medium">{formatAmount(r.balance, r.currency)}</span> },
  ];

  return (
    <>
      <PageHeader title="Merchant wallet" description="Per-merchant funded balance, derived from journal_entries." icon={Wallet} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Merchants" value={new Set(rows.map((r) => r.merchant_id)).size} loading={q.isLoading} />
        <KpiTile label="Currencies" value={currencies.length} loading={q.isLoading} />
        <KpiTile label="Balances" value={rows.length} loading={q.isLoading} />
        <KpiTile label="Aggregate" value={formatAmount(totalAll)} variant="success" loading={q.isLoading} />
      </div>
      <DataView rows={rows} columns={cols} rowKey={(r) => `${r.merchant_id}-${r.currency}`} loading={q.isLoading}
        search={{ placeholder: "Search by merchant…", fields: ["merchant_id", "currency"] }}
        filters={currencies.slice(0, 4).map((c) => ({ key: `c-${c}`, label: c, predicate: (r: Balance) => r.currency === c }))}
        savedViewKey="merchant-wallet" refresh={() => q.refetch()}
        emptyTitle="No wallet activity yet" />
    </>
  );
}
