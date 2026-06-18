"use client";

// L1 — disputes. World-class DataView w/ status + deadline-urgency filter
// chips, table + kanban-by-status, row kebab w/ Open / Represent / Win /
// Lose. Open form moved into a dialog so the list page leads with the work.

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Scale, Gavel, ShieldCheck, AlertTriangle, Plus, ExternalLink, XOctagon,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataView } from "@/components/world-class/data-view";
import { RowActions } from "@/components/world-class/row-actions";
import { useCan } from "@/lib/use-access";
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

const fmtMoney = (m: string, c: string) => {
  const exp = c === "JPY" ? 0 : c === "USDT" ? 6 : 2;
  try { return `${c} ${(Number(BigInt(m)) / 10 ** exp).toFixed(exp)}`; } catch { return `${c} ${m}`; }
};

function OpenDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
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
    onSuccess: () => { toast.success("Dispute opened — reserve held"); qc.invalidateQueries({ queryKey: ["disputes"] }); setOpen(false); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus /> Open dispute</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open dispute</DialogTitle>
          <DialogDescription>Posts a balanced dispute.open journal and holds funds.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>TXN id</Label><Input value={txn} onChange={(e) => setTxn(e.target.value)} placeholder="TXN-…" /></div>
          <div className="space-y-1.5"><Label>Reason code</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Amount (minor INR)</Label><Input value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !txn}><Gavel className="h-4 w-4" /> {m.isPending ? "Opening…" : "Open"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QuickTransition({ dispute, to, label }: { dispute: Dispute; to: string; label: string }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/disputes/${dispute.dispute_id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, notes: `${label} via list UI` }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: () => { toast.success(`Dispute → ${to}`); qc.invalidateQueries({ queryKey: ["disputes"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return m;
}

export default function DisputesPage() {
  const canCreate = useCan("disputes", "create");
  const canUpdate = useCan("disputes", "update");

  const q = useQuery({
    queryKey: ["disputes"],
    queryFn: async () => (await fetch("/api/disputes").then((r) => r.json())) as { disputes: Dispute[] },
    refetchInterval: 8000,
  });
  const rows = q.data?.disputes ?? [];

  const cols: Column<Dispute>[] = [
    { key: "opened_at", header: "Opened", render: (r) => <span className="text-xs">{formatDateTime(r.opened_at)}</span> },
    { key: "status", header: "State", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "txn_id", header: "TXN",
      render: (r) => <Link href={`/disputes/${r.dispute_id}`} className="font-mono text-xs text-[color:var(--color-brand)] hover:underline">{r.txn_id}</Link> },
    { key: "merchant_id", header: "Merchant" },
    { key: "reason_code", header: "Reason" },
    { key: "amount_minor", header: "Amount", render: (r) => <span className="tabular-nums">{fmtMoney(r.amount_minor, r.currency)}</span> },
    { key: "deadline_at", header: "Deadline", render: (r) => {
      if (!r.deadline_at) return "—";
      const d = Math.ceil((new Date(r.deadline_at).getTime() - Date.now()) / 86400_000);
      const closed = ["WON", "LOST", "ACCEPTED", "EXPIRED"].includes(r.status);
      if (closed) return <span className="text-xs">{formatDateTime(r.deadline_at)}</span>;
      return <Badge variant={d <= 1 ? "danger" : d <= 3 ? "warning" : "default"}>{d}d</Badge>;
    }},
  ];

  return (
    <>
      <PageHeader
        title="Disputes"
        description="Chargeback lifecycle (BRD §10 P6). Every transition posts a balanced journal."
        icon={Scale}
        actions={canCreate ? <OpenDialog /> : null}
      />
      <DataView
        rows={rows}
        columns={cols}
        rowKey={(r) => r.dispute_id}
        loading={q.isLoading}
        href={(r) => `/disputes/${r.dispute_id}`}
        search={{ placeholder: "Search by txn id, merchant, reason…", fields: ["txn_id", "merchant_id", "reason_code", "opened_by"] }}
        filters={[
          { key: "open",          label: "Open",           predicate: (r: Dispute) => r.status === "DISPUTE_OPEN" },
          { key: "represent",     label: "In representment", predicate: (r: Dispute) => r.status === "REPRESENTMENT" },
          { key: "urgent",        label: "Deadline ≤3d",   predicate: (r: Dispute) => {
            if (!r.deadline_at || ["WON","LOST","ACCEPTED","EXPIRED"].includes(r.status)) return false;
            return new Date(r.deadline_at).getTime() - Date.now() <= 3 * 86400_000;
          }},
          { key: "won",           label: "Won",            predicate: (r: Dispute) => r.status === "WON" },
          { key: "lost",          label: "Lost",           predicate: (r: Dispute) => r.status === "LOST" },
        ]}
        modes={["table", "kanban"]}
        kanbanColumn={(r) => r.status}
        kanbanColumns={[
          { key: "DISPUTE_OPEN", label: "Open" },
          { key: "REPRESENTMENT", label: "Representment" },
          { key: "WON", label: "Won" },
          { key: "LOST", label: "Lost" },
        ]}
        renderCard={(r) => (
          <Link href={`/disputes/${r.dispute_id}`} className="block rounded-md border bg-[color:var(--color-surface)] p-2 text-sm hover:bg-[color:var(--color-surface-muted)]">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs">{r.txn_id}</span>
              <span className="font-medium tabular-nums">{fmtMoney(r.amount_minor, r.currency)}</span>
            </div>
            <div className="mt-1 truncate text-xs text-[color:var(--color-text-muted)]">{r.merchant_id} · {r.reason_code}</div>
          </Link>
        )}
        savedViewKey="disputes"
        refresh={() => q.refetch()}
        emptyTitle="No disputes yet"
        emptyDescription="When a chargeback fires (or you open one), it'll appear here in real time."
        rowActions={(r) => {
          const closed = ["WON", "LOST", "ACCEPTED", "EXPIRED"].includes(r.status);
          return (
            <RowActions
              openHref={`/disputes/${r.dispute_id}`}
              actions={[
                { label: "Open detail", icon: ExternalLink, onClick: () => (window.location.href = `/disputes/${r.dispute_id}`) },
                ...(canUpdate && !closed ? [
                  ...(r.status === "DISPUTE_OPEN" ? [{ label: "Represent", icon: Gavel, onClick: () => QuickTransition({ dispute: r, to: "REPRESENTMENT", label: "Represent" }) }] : []),
                  { label: "Win", icon: ShieldCheck, onClick: () => (window.location.href = `/disputes/${r.dispute_id}?action=win`) },
                  { label: "Lose", icon: AlertTriangle, variant: "danger" as const, onClick: () => (window.location.href = `/disputes/${r.dispute_id}?action=lose`) },
                ] : []),
              ]}
            />
          );
        }}
      />
    </>
  );
}
