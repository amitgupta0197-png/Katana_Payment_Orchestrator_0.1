"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Refund {
  refund_id: string; order_id: string; txn_id: string; merchant_id: string;
  amount_minor: string; currency: string; reason: string; status: string;
  partial: boolean; journal_id: string; requested_by: string;
  requested_at: string; posted_at: string | null; failure_reason: string;
}

export default function RefundsPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["refunds"],
    queryFn: async () => (await fetch("/api/refunds").then((r) => r.json())) as { refunds: Refund[] },
    refetchInterval: 6000,
  });
  const [txn, setTxn] = useState(""); const [amt, setAmt] = useState("100");
  const [reason, setReason] = useState("customer_request");
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/refunds", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txn_id: txn, amount_minor: amt, reason }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: () => { toast.success("Refund posted"); qc.invalidateQueries({ queryKey: ["refunds"] }); setTxn(""); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const cols: Column<Refund>[] = [
    { key: "requested_at", header: "Requested", render: (r) => formatDateTime(r.requested_at) },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "partial", header: "Type", render: (r) => r.partial ? <Badge variant="warning">partial</Badge> : <Badge variant="default">full</Badge> },
    { key: "txn_id", header: "TXN", render: (r) => <span className="font-mono text-xs">{r.txn_id}</span> },
    { key: "merchant_id", header: "Merchant" },
    { key: "amount_minor", header: "Amount", render: (r) => `${r.currency} ${r.amount_minor}` },
    { key: "reason", header: "Reason" },
    { key: "journal_id", header: "Journal", render: (r) => <span className="font-mono text-xs">{r.journal_id?.slice(0,8) ?? "—"}</span> },
    { key: "requested_by", header: "By" },
  ];

  return (
    <>
      <PageHeader title="Refunds" description="Refund lifecycle (BRD §7 P3 + §10 P6). Every refund posts a balanced journal." icon={RotateCcw} />
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Issue refund</CardTitle><CardDescription>State transitions: SUCCESS → REFUNDED / PARTIALLY_REFUNDED.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div><Label>TXN id</Label><Input value={txn} onChange={(e) => setTxn(e.target.value)} placeholder="TXN-..." /></div>
            <div><Label>Amount (minor)</Label><Input value={amt} onChange={(e) => setAmt(e.target.value)} /></div>
            <div><Label>Reason</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          </div>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !txn}><Plus className="h-4 w-4" /> {m.isPending ? "Posting…" : "Issue refund"}</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Refunds ({(q.data?.refunds ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.refunds ?? []} rowKey={(r) => r.refund_id} emptyState="No refunds yet." /></CardContent>
      </Card>
    </>
  );
}
