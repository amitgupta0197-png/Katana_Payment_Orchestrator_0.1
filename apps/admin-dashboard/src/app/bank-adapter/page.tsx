"use client";

import { useQuery } from "@tanstack/react-query";
import { Network } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Rail { id: string; code: string; name: string; capabilities: string[]; health: string; created_at: string }
interface Disbursement { id: string; rail_code: string; beneficiary_ifsc: string; beneficiary_account: string; amount: number; currency: string; status: string; created_at: string }

export default function BankAdapterPage() {
  const q = useQuery({
    queryKey: ["bank-adapter"],
    queryFn: async () => (await fetch("/api/bank-adapter").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { rails: Rail[]; recent_disbursements: Disbursement[] },
  });
  const rCols: Column<Rail>[] = [
    { key: "code", header: "Code" },
    { key: "name", header: "Name" },
    { key: "capabilities", header: "Capabilities", render: (r) => (r.capabilities ?? []).join(", ") || "—" },
    { key: "health", header: "Health", render: (r) => <Badge variant={statusVariant(r.health)}>{r.health}</Badge> },
  ];
  const dCols: Column<Disbursement>[] = [
    { key: "rail_code", header: "Rail" },
    { key: "beneficiary_ifsc", header: "IFSC" },
    { key: "beneficiary_account", header: "Account" },
    { key: "amount", header: "Amount", render: (r) => formatAmount(r.amount, r.currency) },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "When", render: (r) => formatDateTime(r.created_at) },
  ];
  return (
    <>
      <PageHeader title="Bank adapters" description="Bank payout adapter pool + recent disbursements." icon={Network} />
      <Card className="mb-4">
        <CardHeader><CardTitle>Rails ({(q.data?.rails ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={rCols} rows={q.data?.rails ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No bank rails." /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Recent disbursements ({(q.data?.recent_disbursements ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={dCols} rows={q.data?.recent_disbursements ?? []} rowKey={(r) => r.id} emptyState="No disbursements." /></CardContent>
      </Card>
    </>
  );
}
