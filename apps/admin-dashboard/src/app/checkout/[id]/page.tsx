"use client";

import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CreditCard, ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Order {
  id: string; tenant_id: string; merchant_id: string; client_ref: string; txn_id?: string;
  amount: number; currency: string; method: string; selected_rail?: string; status: string;
  customer_email: string; idempotency_key: string; created_at: string;
}
interface Event { event_id: string; actor_subject: string; actor_type: string; action: string; occurred_at: string; metadata: any }
interface Callback { id: string; vendor: string; kind: string; received_at: string; vendor_txn_id: string; signature_ok: boolean; processed: boolean; process_error: string }
interface Journal { id: string; posted_at: string; narration: string; currency: string; ref_type: string; ref_id: string }

export default function CheckoutDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useQuery({
    queryKey: ["order", id],
    queryFn: async () => (await fetch(`/api/checkout/${id}`).then((r) => r.json())) as {
      order: Order; events: Event[]; callbacks: Callback[]; journals: Journal[];
    },
  });

  if (q.isLoading) return <Card><CardContent className="py-8 text-center">Loading…</CardContent></Card>;
  if (!q.data?.order) {
    return (
      <>
        <PageHeader title="Order not found" icon={CreditCard} />
        <Card><CardContent className="py-8 text-center"><Link className="text-[color:var(--color-brand)] hover:underline" href="/checkout">← back to checkout</Link></CardContent></Card>
      </>
    );
  }

  const { order, events, callbacks, journals } = q.data;
  const eventCols: Column<Event>[] = [
    { key: "occurred_at", header: "When", render: (r) => formatDateTime(r.occurred_at) },
    { key: "actor_subject", header: "Actor", render: (r) => `${r.actor_subject} (${r.actor_type})` },
    { key: "action", header: "Action" },
    { key: "metadata", header: "Payload", render: (r) => <span className="font-mono text-xs">{JSON.stringify(r.metadata).slice(0,80)}</span> },
  ];
  const callbackCols: Column<Callback>[] = [
    { key: "vendor", header: "Vendor" },
    { key: "kind", header: "Kind" },
    { key: "vendor_txn_id", header: "Vendor TXN", render: (r) => r.vendor_txn_id ? <span className="font-mono text-xs">{r.vendor_txn_id}</span> : "—" },
    { key: "signature_ok", header: "Sig", render: (r) => r.signature_ok ? <Badge variant="success">ok</Badge> : <Badge variant="danger">bad</Badge> },
    { key: "processed", header: "Processed", render: (r) => r.processed ? <Badge variant="success">yes</Badge> : <Badge variant="warning">queued</Badge> },
    { key: "process_error", header: "Error", render: (r) => r.process_error ? <span className="text-[color:var(--color-danger)] text-xs">{r.process_error}</span> : "—" },
    { key: "received_at", header: "When", render: (r) => formatDateTime(r.received_at) },
  ];
  const journalCols: Column<Journal>[] = [
    { key: "posted_at", header: "Posted", render: (r) => formatDateTime(r.posted_at) },
    { key: "ref_type", header: "Ref" },
    { key: "narration", header: "Narration", render: (r) => r.narration || "—" },
    { key: "currency", header: "Cur" },
  ];

  return (
    <>
      <PageHeader
        title={order.client_ref || `Order ${order.id.slice(0, 8)}`}
        description={`merchant ${order.merchant_id} · ${order.method} · ${order.selected_rail ?? "(unrouted)"} · created ${formatDateTime(order.created_at)}`}
        icon={CreditCard}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(order.status)}>{order.status}</Badge>
            <Link href="/checkout" className="text-xs text-[color:var(--color-text-muted)] hover:text-[color:var(--color-brand)] inline-flex items-center"><ChevronLeft className="h-3 w-3" /> back</Link>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 mb-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Order</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div><span className="text-[color:var(--color-text-muted)]">ID:</span> <span className="font-mono text-xs">{order.id}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">TXN:</span> <span className="font-mono text-xs">{order.txn_id || "—"}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">Client ref:</span> {order.client_ref}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Amount:</span> {formatAmount(order.amount, order.currency)}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Method:</span> {order.method}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Rail:</span> {order.selected_rail || "—"}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Customer email:</span> {order.customer_email || "—"}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Idempotency:</span> <span className="font-mono text-xs">{order.idempotency_key || "—"}</span></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Drill-down</CardTitle><CardDescription>Click into related entities.</CardDescription></CardHeader>
          <CardContent className="text-sm space-y-2">
            <div>
              <span className="text-[color:var(--color-text-muted)]">Merchant:</span>{" "}
              <Link className="text-[color:var(--color-brand)] hover:underline font-mono text-xs" href={`/merchants?code=${order.merchant_id}`}>{order.merchant_id}</Link>
            </div>
            {order.selected_rail && (
              <div>
                <span className="text-[color:var(--color-text-muted)]">Rail / vendor:</span>{" "}
                <Link className="text-[color:var(--color-brand)] hover:underline" href={`/vendors/${order.selected_rail.toLowerCase().includes("poolpay") ? "poolpay" : "quickpay"}`}>open cockpit</Link>
              </div>
            )}
            <div>
              <span className="text-[color:var(--color-text-muted)]">Ledger:</span>{" "}
              <Link className="text-[color:var(--color-brand)] hover:underline" href="/ledger">all journals</Link>
            </div>
            <div>
              <span className="text-[color:var(--color-text-muted)]">Audit:</span>{" "}
              <Link className="text-[color:var(--color-brand)] hover:underline" href="/admin-log">full audit log</Link>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Vendor callbacks ({callbacks.length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={callbackCols} rows={callbacks} rowKey={(r) => r.id} emptyState="No callbacks recorded yet." /></CardContent>
      </Card>
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Ledger journals ({journals.length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={journalCols} rows={journals} rowKey={(r) => r.id} emptyState="No ledger postings against this order." /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Activity events ({events.length})</CardTitle><CardDescription>Hash-chained audit trail (auditservice).</CardDescription></CardHeader>
        <CardContent><DataTable columns={eventCols} rows={events} rowKey={(r) => r.event_id} emptyState="No audit events for this order yet." /></CardContent>
      </Card>
    </>
  );
}
