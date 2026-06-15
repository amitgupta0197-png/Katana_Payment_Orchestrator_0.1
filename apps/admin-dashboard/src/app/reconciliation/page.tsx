"use client";

import { useQuery } from "@tanstack/react-query";
import { GitMerge } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Break {
  id: string; run_id: string; reference: string; break_type: string;
  sources_present: string[]; amount: number; currency: string; delta: number;
  status: string; assignee: string; opened_at: string; resolved_at?: string;
}

export default function ReconciliationPage() {
  const q = useQuery({
    queryKey: ["recon:breaks"],
    queryFn: async () => (await fetch("/api/recon/breaks").then((r) => r.json())) as { breaks: Break[] },
  });
  const cols: Column<Break>[] = [
    { key: "reference", header: "Ref" },
    { key: "break_type", header: "Type" },
    { key: "sources_present", header: "Sources", render: (r) => (r.sources_present ?? []).join(", ") || "—" },
    { key: "amount", header: "Amount", render: (r) => formatAmount(r.amount, r.currency) },
    { key: "delta", header: "Δ", render: (r) => formatAmount(r.delta, r.currency) },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "assignee", header: "Assignee", render: (r) => r.assignee || "—" },
    { key: "opened_at", header: "Opened", render: (r) => formatDateTime(r.opened_at) },
  ];
  return (
    <>
      <PageHeader title="Reconciliation" description="Open breaks needing operator review." icon={GitMerge} />
      <Card><CardHeader><CardTitle>{(q.data?.breaks ?? []).length} breaks</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.breaks ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No recon breaks. Match is clean." /></CardContent>
      </Card>
    </>
  );
}
