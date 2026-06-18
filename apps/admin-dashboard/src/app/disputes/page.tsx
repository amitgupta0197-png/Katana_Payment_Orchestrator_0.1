"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Scale, Gavel, ShieldCheck, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Dispute {
  dispute_id: string; txn_id: string; order_id: string | null;
  merchant_id: string; reason_code: string;
  amount_minor: string; currency: string; status: string;
  deadline_at: string | null;
  opened_at: string; opened_by: string;
  resolved_at: string | null; resolved_by: string;
  resolution_notes: string;
  hold_journal_id: string; resolution_journal_id: string | null;
}

function OpenForm() {
  const qc = useQueryClient();
  const [txn, setTxn] = useState("");
  const [amount, setAmount] = useState("50000");
  const [reason, setReason] = useState("10.4 fraud");
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/disputes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txn_id: txn, amount_minor: amount, reason_code: reason, currency: "INR" }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: () => { toast.success("Dispute opened — reserve held"); qc.invalidateQueries({ queryKey: ["disputes"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Open dispute</CardTitle><CardDescription>Posts a balanced dispute.open journal and holds funds.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div><Label>TXN id</Label><Input value={txn} onChange={(e) => setTxn(e.target.value)} placeholder="TXN-..." /></div>
          <div><Label>Reason</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div><Label>Amount (minor INR)</Label><Input value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        </div>
        <Button onClick={() => m.mutate()} disabled={m.isPending || !txn}>
          <Gavel className="h-4 w-4" /> {m.isPending ? "Opening…" : "Open dispute"}
        </Button>
      </CardContent>
    </Card>
  );
}

function ResolveButton({ row, to, label, variant }: { row: Dispute; to: string; label: string; variant: "default" | "danger" | "secondary" }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/disputes/${row.dispute_id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, notes: `${label} via UI` }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: () => { toast.success(`Dispute → ${to}`); qc.invalidateQueries({ queryKey: ["disputes"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return <Button size="sm" variant={variant} onClick={() => m.mutate()} disabled={m.isPending}>{label}</Button>;
}

export default function DisputesPage() {
  const q = useQuery({
    queryKey: ["disputes"],
    queryFn: async () => (await fetch("/api/disputes").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { disputes: Dispute[] },
    refetchInterval: 6000,
  });
  const open = (q.data?.disputes ?? []).filter(d => d.status === "DISPUTE_OPEN" || d.status === "REPRESENTMENT");
  const closed = (q.data?.disputes ?? []).filter(d => ["ACCEPTED","WON","LOST","EXPIRED"].includes(d.status));

  const fmtMoney = (m: string, c: string) => {
    const exp = c === "JPY" ? 0 : c === "USDT" ? 6 : 2;
    const n = BigInt(m);
    const div = BigInt(10 ** exp);
    return `${c} ${(Number(n) / Number(div)).toFixed(exp)}`;
  };

  const cols: Column<Dispute>[] = [
    { key: "opened_at", header: "Opened", render: (r) => formatDateTime(r.opened_at) },
    { key: "status", header: "State", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "txn_id", header: "TXN", render: (r) => <span className="font-mono text-xs">{r.txn_id}</span> },
    { key: "merchant_id", header: "Merchant" },
    { key: "reason_code", header: "Reason" },
    { key: "amount_minor", header: "Amount", render: (r) => fmtMoney(r.amount_minor, r.currency) },
    { key: "deadline_at", header: "Deadline", render: (r) => r.deadline_at ? formatDateTime(r.deadline_at) : "—" },
    { key: "hold_journal_id", header: "Hold", render: (r) => <span className="font-mono text-xs">{r.hold_journal_id?.slice(0, 8) ?? "—"}</span> },
    { key: "dispute_id", header: "Action", render: (r) => {
      if (["ACCEPTED","WON","LOST","EXPIRED"].includes(r.status))
        return <span className="text-xs text-[color:var(--color-text-muted)]">{r.resolved_at ? formatDateTime(r.resolved_at) : "—"}</span>;
      return (
        <div className="flex gap-1">
          {r.status === "DISPUTE_OPEN" && <ResolveButton row={r} to="REPRESENTMENT" label="Represent" variant="secondary" />}
          <ResolveButton row={r} to="WON" label="Win" variant="default" />
          <ResolveButton row={r} to="LOST" label="Lose" variant="danger" />
        </div>
      );
    }},
  ];

  return (
    <>
      <PageHeader
        title="Disputes"
        description="Chargeback lifecycle (BRD §10 P6). Every transition posts a balanced journal."
        icon={Scale}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={open.length > 0 ? "warning" : "default"}><AlertTriangle className="h-3 w-3" /> {open.length} open</Badge>
            <Badge variant="success"><ShieldCheck className="h-3 w-3" /> {closed.filter(c => c.status === "WON").length} won</Badge>
          </div>
        }
      />
      <div className="mb-4"><OpenForm /></div>
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Open & representment ({open.length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={open} rowKey={(r) => r.dispute_id} emptyState="No active disputes." /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Resolved ({closed.length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={closed} rowKey={(r) => r.dispute_id} emptyState="No resolved disputes yet." /></CardContent>
      </Card>
    </>
  );
}
