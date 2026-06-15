"use client";

import { useQuery } from "@tanstack/react-query";
import { Banknote } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface VendorBalance { id: string; vendor: string; env: string; balance: number; currency: string; captured_at: string }
interface BankStatement { id: string; rail_code: string; account_no: string; amount: number; currency: string; direction: string; value_date: string }

export default function FundPage() {
  const q = useQuery({
    queryKey: ["fund"],
    queryFn: async () => (await fetch("/api/fund").then((r) => r.json())) as { vendor_balances: VendorBalance[]; recent_bank_statements: BankStatement[] },
  });

  const balanceCols: Column<VendorBalance>[] = [
    { key: "vendor", header: "Vendor" },
    { key: "env", header: "Env" },
    { key: "balance", header: "Balance", render: (r) => formatAmount(r.balance, r.currency) },
    { key: "captured_at", header: "Captured", render: (r) => formatDateTime(r.captured_at) },
  ];
  const stmtCols: Column<BankStatement>[] = [
    { key: "rail_code", header: "Rail" },
    { key: "account_no", header: "Account" },
    { key: "direction", header: "Direction" },
    { key: "amount", header: "Amount", render: (r) => formatAmount(r.amount, r.currency) },
    { key: "value_date", header: "Date", render: (r) => formatDateTime(r.value_date) },
  ];

  return (
    <>
      <PageHeader title="Fund / treasury" description="Vendor balance snapshots + recent bank statement lines." icon={Banknote} />
      <Card className="mb-4">
        <CardHeader><CardTitle>Vendor balances ({(q.data?.vendor_balances ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={balanceCols} rows={q.data?.vendor_balances ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No balance snapshots." /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Bank statements ({(q.data?.recent_bank_statements ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={stmtCols} rows={q.data?.recent_bank_statements ?? []} rowKey={(r) => r.id} emptyState="No statement activity." /></CardContent>
      </Card>
    </>
  );
}
