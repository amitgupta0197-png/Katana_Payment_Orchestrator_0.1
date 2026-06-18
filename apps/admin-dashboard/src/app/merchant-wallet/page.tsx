"use client";

import { useQuery } from "@tanstack/react-query";
import { Wallet } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount } from "@/lib/utils";

interface Balance { merchant_id: string; currency: string; balance: number }

export default function MerchantWalletPage() {
  const q = useQuery({
    queryKey: ["balances"],
    queryFn: async () => (await fetch("/api/ledger/balance").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { balances: Balance[] },
  });
  const cols: Column<Balance>[] = [
    { key: "merchant_id", header: "Merchant" },
    { key: "currency", header: "Currency" },
    { key: "balance", header: "Balance", render: (r) => formatAmount(r.balance, r.currency) },
  ];
  return (
    <>
      <PageHeader title="Merchant wallet" description="Per-merchant funded balance, derived from journal_entries." icon={Wallet} />
      <Card><CardHeader><CardTitle>{(q.data?.balances ?? []).length} merchant balances</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.balances ?? []} loading={q.isLoading} rowKey={(r) => `${r.merchant_id}-${r.currency}`} emptyState="No wallet activity yet." /></CardContent>
      </Card>
    </>
  );
}
