"use client";

// L1 — fund / treasury. Tabs (Vendor balances / Bank statements).

import { useQuery } from "@tanstack/react-query";
import { Banknote, Wallet, FileText } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataView } from "@/components/world-class/data-view";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface VendorBalance { id: string; vendor: string; env: string; balance: number; currency: string; captured_at: string }
interface BankStatement { id: string; rail_code: string; account_no: string; amount: number; currency: string; direction: string; value_date: string }

export default function FundPage() {
  const q = useQuery({
    queryKey: ["fund"],
    queryFn: async () => (await fetch("/api/fund").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { vendor_balances: VendorBalance[]; recent_bank_statements: BankStatement[] },
  });
  const balances = q.data?.vendor_balances ?? [];
  const stmts = q.data?.recent_bank_statements ?? [];

  const balanceCols: Column<VendorBalance>[] = [
    { key: "vendor", header: "Vendor", render: (r) => <Badge variant="brand">{r.vendor}</Badge> },
    { key: "env", header: "Env" },
    { key: "balance", header: "Balance", render: (r) => <span className="tabular-nums font-medium">{formatAmount(r.balance, r.currency)}</span> },
    { key: "captured_at", header: "Captured", render: (r) => <span className="text-xs">{formatDateTime(r.captured_at)}</span> },
  ];
  const stmtCols: Column<BankStatement>[] = [
    { key: "rail_code", header: "Rail", render: (r) => <Badge variant="brand">{r.rail_code}</Badge> },
    { key: "account_no", header: "Account", render: (r) => <span className="font-mono text-xs">{r.account_no}</span> },
    { key: "direction", header: "Direction", render: (r) => <Badge variant={r.direction === "credit" || r.direction === "CR" ? "success" : "warning"}>{r.direction}</Badge> },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency)}</span> },
    { key: "value_date", header: "Date", render: (r) => <span className="text-xs">{formatDateTime(r.value_date)}</span> },
  ];

  return (
    <>
      <PageHeader title="Fund / treasury" description="Vendor balance snapshots + recent bank statement lines." icon={Banknote} />
      <Tabs defaultValue="balances">
        <TabsList>
          <TabsTrigger value="balances"><Wallet className="h-3.5 w-3.5" /> Vendor balances
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{balances.length}</span>
          </TabsTrigger>
          <TabsTrigger value="statements"><FileText className="h-3.5 w-3.5" /> Bank statements
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{stmts.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="balances">
          <DataView rows={balances} columns={balanceCols} rowKey={(r) => r.id} loading={q.isLoading}
            search={{ placeholder: "Search by vendor / env…", fields: ["vendor", "env", "currency"] }}
            savedViewKey="fund-balances" refresh={() => q.refetch()}
            emptyTitle="No balance snapshots" emptyDescription="Snapshots pull on schedule from each vendor portal." />
        </TabsContent>
        <TabsContent value="statements">
          <DataView rows={stmts} columns={stmtCols} rowKey={(r) => r.id}
            search={{ placeholder: "Search by rail / account…", fields: ["rail_code", "account_no", "direction"] }}
            filters={[
              { key: "credit", label: "Credits", predicate: (r: BankStatement) => r.direction === "credit" || r.direction === "CR" },
              { key: "debit",  label: "Debits",  predicate: (r: BankStatement) => r.direction === "debit"  || r.direction === "DR" },
            ]}
            savedViewKey="fund-statements"
            emptyTitle="No statement activity" />
        </TabsContent>
      </Tabs>
    </>
  );
}
