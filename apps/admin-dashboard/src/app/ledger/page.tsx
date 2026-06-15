"use client";

import { useQuery } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface Journal { id: string; posted_at: string; currency: string; narration?: string; ref_type: string; ref_id: string; idempotency_key: string }
interface Account { id: string; code: string; parent_code: string; type: string; currency: string; normal_balance: string; closed: boolean }
interface Balance { merchant_id: string; currency: string; balance: number }

export default function LedgerPage() {
  const journals = useQuery({
    queryKey: ["ledger:journals"],
    queryFn: async () => (await fetch("/api/ledger/journals").then((r) => r.json())) as { journals: Journal[] },
  });
  const accounts = useQuery({
    queryKey: ["ledger:accounts"],
    queryFn: async () => (await fetch("/api/ledger/accounts").then((r) => r.json())) as { accounts: Account[] },
  });
  const balances = useQuery({
    queryKey: ["ledger:balances"],
    queryFn: async () => (await fetch("/api/ledger/balance").then((r) => r.json())) as { balances: Balance[] },
  });

  const jCols: Column<Journal>[] = [
    { key: "posted_at", header: "Posted", render: (r) => formatDateTime(r.posted_at) },
    { key: "ref_type", header: "Ref" },
    { key: "ref_id", header: "Ref ID" },
    { key: "narration", header: "Narration", render: (r) => r.narration ?? "—" },
    { key: "currency", header: "Cur" },
  ];
  const aCols: Column<Account>[] = [
    { key: "code", header: "Code" },
    { key: "type", header: "Type" },
    { key: "normal_balance", header: "Normal" },
    { key: "currency", header: "Cur" },
    { key: "parent_code", header: "Parent" },
  ];
  const bCols: Column<Balance>[] = [
    { key: "merchant_id", header: "Merchant" },
    { key: "currency", header: "Cur" },
    { key: "balance", header: "Balance", render: (r) => formatAmount(r.balance, r.currency) },
  ];

  return (
    <>
      <PageHeader title="Ledger" description="Double-entry journal, account map, and merchant balances." icon={BookOpen} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 mb-4">
        <Card><CardHeader><CardTitle>Accounts ({(accounts.data?.accounts ?? []).length})</CardTitle></CardHeader>
          <CardContent><DataTable columns={aCols} rows={accounts.data?.accounts ?? []} loading={accounts.isLoading} rowKey={(r) => r.id} emptyState="No chart of accounts." /></CardContent>
        </Card>
        <Card><CardHeader><CardTitle>Merchant balances ({(balances.data?.balances ?? []).length})</CardTitle></CardHeader>
          <CardContent><DataTable columns={bCols} rows={balances.data?.balances ?? []} loading={balances.isLoading} rowKey={(r) => `${r.merchant_id}-${r.currency}`} emptyState="No balances." /></CardContent>
        </Card>
      </div>
      <Card><CardHeader><CardTitle>Recent journals ({(journals.data?.journals ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={jCols} rows={journals.data?.journals ?? []} loading={journals.isLoading} rowKey={(r) => r.id} emptyState="No journal entries." /></CardContent>
      </Card>
    </>
  );
}
