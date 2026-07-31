"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CreditCard, ChevronLeft, CheckCircle2, Circle, GitBranch } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";
import { STATE_ORDER, stateColor, type PaymentState } from "@/lib/payment-states";

interface Order {
  id: string; tenant_id: string; merchant_id: string; client_ref: string; txn_id?: string;
  amount: number; amount_minor: string; currency: string; method: string;
  selected_rail?: string; status: string;
  customer_email: string; idempotency_key: string; created_at: string;
}
interface Event { event_id: string; actor_subject: string; actor_type: string; action: string; occurred_at: string; metadata: any }
interface Callback { id: string; vendor: string; kind: string; received_at: string; vendor_txn_id: string; signature_ok: boolean; processed: boolean; process_error: string }
interface Journal { id: string; posted_at: string; narration: string; currency: string; ref_type: string; ref_id: string }
interface Attempt {
  id: string; attempt_no: number; provider: string; method: string;
  status: string; provider_txn_id: string; auth_status: string;
  next_state: string; error_code: string; error_message: string;
  response_time_ms: number; started_at: string; completed_at: string;
}
interface Transition { id: string; from_status: string; to_status: string; actor_kind: string; actor_id: string; reason: string; occurred_at: string }
interface RouteCand { rank: number; provider: string; score: number; reasoning: string }
interface RouteData {
  id: string; winner: string; score: number; selected_rank: number;
  cascade_ranks: RouteCand[]; factors: Record<string, any>;
  weights_applied: Record<string, number>; decided_at: string;
}

export default function CheckoutDetailView({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["order", id],
    queryFn: async () => (await fetch(`/api/checkout/${id}`).then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as {
      order: Order; events: Event[]; callbacks: Callback[]; journals: Journal[];
      attempts: Attempt[]; transitions: Transition[]; route: RouteData | null;
    },
    refetchInterval: 5000,
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

  const { order, events, callbacks, journals, attempts, transitions, route } = q.data;
  const currentState = order.status as PaymentState;

  // Build the visible stepper. Show happy-path order, but also show terminal
  // states inline if the order ended up there.
  const happyPath = STATE_ORDER;
  const stateIdx = happyPath.indexOf(currentState);
  const onHappyPath = stateIdx >= 0;

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
  const attemptCols: Column<Attempt>[] = [
    { key: "attempt_no", header: "#" },
    { key: "provider", header: "Provider", render: (r) => <Badge variant="brand">{r.provider}</Badge> },
    { key: "status", header: "Outcome", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "next_state", header: "Next state", render: (r) => r.next_state ? <Badge variant={stateColor(r.next_state as PaymentState)}>{r.next_state}</Badge> : "—" },
    { key: "auth_status", header: "Auth", render: (r) => r.auth_status || "—" },
    { key: "provider_txn_id", header: "Provider txn", render: (r) => r.provider_txn_id ? <span className="font-mono text-xs">{r.provider_txn_id}</span> : "—" },
    { key: "response_time_ms", header: "ms" },
    { key: "error_code", header: "Error", render: (r) => r.error_code ? <span className="text-[color:var(--color-danger)] text-xs">{r.error_code}</span> : "—" },
    { key: "started_at", header: "Started", render: (r) => formatDateTime(r.started_at) },
  ];
  const transitionCols: Column<Transition>[] = [
    { key: "occurred_at", header: "When", render: (r) => formatDateTime(r.occurred_at) },
    { key: "from_status", header: "From", render: (r) => r.from_status ? <Badge variant={stateColor(r.from_status as PaymentState)}>{r.from_status}</Badge> : "—" },
    { key: "to_status", header: "→ To", render: (r) => <Badge variant={stateColor(r.to_status as PaymentState)}>{r.to_status}</Badge> },
    { key: "actor_kind", header: "Actor" },
    { key: "reason", header: "Reason" },
  ];
  const routeCols: Column<RouteCand>[] = [
    { key: "rank", header: "#" },
    { key: "provider", header: "Provider", render: (r) => <Badge variant={r.rank === route?.selected_rank ? "success" : "brand"}>{r.provider}</Badge> },
    { key: "score", header: "Score", render: (r) => Number(r.score).toFixed(4) },
    { key: "reasoning", header: "Factors", render: (r) => <span className="font-mono text-xs">{r.reasoning}</span> },
  ];

  return (
    <>
      <PageHeader
        title={order.client_ref || `Order ${order.id.slice(0, 8)}`}
        description={`merchant ${order.merchant_id} · ${order.method} · ${order.selected_rail ?? "(unrouted)"} · created ${formatDateTime(order.created_at)}`}
        icon={CreditCard}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={stateColor(currentState)}>{currentState}</Badge>
            <Link href="/checkout" className="text-xs text-[color:var(--color-text-muted)] hover:text-[color:var(--color-brand)] inline-flex items-center"><ChevronLeft className="h-3 w-3" /> back</Link>
          </div>
        }
      />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Payment state machine (BRD §7)</CardTitle>
          <CardDescription>CREATED → AUTH_REQUIRED → AUTH_CHALLENGE → AUTHENTICATED → PROCESSING → SUCCESS.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-wrap items-center gap-2">
            {happyPath.map((st, i) => {
              const done = onHappyPath ? i < stateIdx : false;
              const now = st === currentState;
              return (
                <li key={st} className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${now ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)]" : ""}`}>
                  {done ? <CheckCircle2 className="h-4 w-4 text-[color:var(--color-success)]" /> : <Circle className="h-4 w-4 text-[color:var(--color-text-subtle)]" />}
                  <Badge variant={stateColor(st)}>{st}</Badge>
                </li>
              );
            })}
            {!onHappyPath && (
              <li className="rounded-md border px-3 py-2 text-sm">
                <Badge variant={stateColor(currentState)}>{currentState}</Badge>
                <span className="ml-2 text-xs text-[color:var(--color-text-muted)]">(off happy path)</span>
              </li>
            )}
          </ol>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 mb-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Order</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div><span className="text-[color:var(--color-text-muted)]">ID:</span> <span className="font-mono text-xs">{order.id}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">TXN:</span> <span className="font-mono text-xs">{order.txn_id || "—"}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">Client ref:</span> {order.client_ref}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Amount:</span> {formatAmount(order.amount, order.currency)} <span className="font-mono text-xs text-[color:var(--color-text-muted)]">({order.amount_minor || "—"} minor)</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">Method:</span> {order.method}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Rail:</span> {order.selected_rail || "—"}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Customer email:</span> {order.customer_email || "—"}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Idempotency:</span> <span className="font-mono text-xs">{order.idempotency_key || "—"}</span></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><GitBranch className="h-4 w-4" /> Routing trace</CardTitle>
            <CardDescription>
              {route ? <>Selected rank #{route.selected_rank} — {route.winner} (score {Number(route.score).toFixed(4)})</> : "No routing decision recorded."}
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            {route ? (
              <>
                <DataTable
                  columns={routeCols}
                  rows={route.cascade_ranks ?? []}
                  rowKey={(r) => `${r.rank}-${r.provider}`}
                  emptyState="No candidates."
                />
                <div className="mt-2 text-xs text-[color:var(--color-text-muted)]">
                  Weights: <span className="font-mono">{JSON.stringify(route.weights_applied)}</span>
                </div>
              </>
            ) : (
              <p className="text-[color:var(--color-text-muted)]">Routing only runs for orders created via POST /api/checkout in Sprint 2+.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Payment attempts ({attempts.length})</CardTitle><CardDescription>One row per provider call (BRD §7 P3 acceptance).</CardDescription></CardHeader>
        <CardContent><DataTable columns={attemptCols} rows={attempts} rowKey={(r) => r.id} emptyState="No attempts recorded." /></CardContent>
      </Card>
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">State transitions ({transitions.length})</CardTitle><CardDescription>Replayable state change log for forensics.</CardDescription></CardHeader>
        <CardContent><DataTable columns={transitionCols} rows={transitions} rowKey={(r) => r.id} emptyState="No transitions yet." /></CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Vendor callbacks ({callbacks.length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={callbackCols} rows={callbacks} rowKey={(r) => r.id} emptyState="No callbacks recorded yet." /></CardContent>
      </Card>
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Ledger journals ({journals.length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={journalCols} rows={journals} rowKey={(r) => r.id} emptyState="No ledger postings against this order." /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Activity events ({events.length})</CardTitle><CardDescription>Legacy hash-chained audit (auditservice).</CardDescription></CardHeader>
        <CardContent><DataTable columns={eventCols} rows={events} rowKey={(r) => r.event_id} emptyState="No audit events for this order yet." /></CardContent>
      </Card>
    </>
  );
}
