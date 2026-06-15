"use client";

import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Chargeback {
  id: string; txn_id?: string; amount: number; reason_code: string; status: string;
  opened_at: string; deadline?: string;
}

export default function DisputesPage() {
  const q = useQuery({
    queryKey: ["mp:risk:chargebacks"],
    queryFn: async () => (await fetch("/api/risk?kind=chargebacks").then((r) => r.json())) as { items: Chargeback[] },
  });

  // TODO: chargeback evidence endpoint. Toast for now.
  const submitEvidence = (id: string) => toast.info(`TODO: submit evidence for ${id}`);

  const cols: Column<Chargeback>[] = [
    { key: "id", header: "Case", render: (r) => <span className="font-mono text-xs">{r.id.slice(0, 8)}</span> },
    { key: "txn_id", header: "Txn", render: (r) => r.txn_id ?? "—" },
    { key: "amount", header: "Amount", render: (r) => formatAmount(r.amount) },
    { key: "reason_code", header: "Reason" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "opened_at", header: "Opened", render: (r) => formatDateTime(r.opened_at) },
    { key: "deadline", header: "Deadline", render: (r) => r.deadline ? formatDateTime(r.deadline) : "—" },
    {
      key: "actions", header: "",
      render: (r) => (
        <Button size="sm" variant="secondary" onClick={() => submitEvidence(r.id)}
          disabled={r.status !== "RECEIVED" && r.status !== "IN_REVIEW"}>
          Submit evidence
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Disputes" description="Chargebacks raised against your transactions." icon={ShieldAlert} />
      <Card>
        <CardHeader><CardTitle>{(q.data?.items ?? []).length} cases</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={q.data?.items ?? []}
            loading={q.isLoading}
            rowKey={(r) => r.id}
            emptyState="No disputes. Good job."
          />
        </CardContent>
      </Card>
    </>
  );
}
