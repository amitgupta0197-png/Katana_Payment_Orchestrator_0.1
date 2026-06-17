"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Webhook, Play, RotateCw, Trash2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDateTime } from "@/lib/utils";

interface OutboxRow {
  outbox_id: string; merchant_id: string; order_id: string | null;
  event_type: string; target_url: string; status: string; attempts: number;
  last_error: string; next_attempt_at: string; created_at: string;
  delivered_at?: string; dead_lettered_at?: string;
  payload: Record<string, unknown>;
}
interface ConfigRow { config_id: string; merchant_id: string; target_url: string; enabled: boolean; updated_at: string }

function DispatchButton() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/webhooks/dispatch", { method: "POST" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: (b) => {
      toast.success(`Dispatched: ${b.picked} picked, ${b.delivered} delivered, ${b.failed} retrying, ${b.dead_lettered} DLQ`);
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (e: Error) => toast.error("Dispatch failed", { description: e.message }),
  });
  return (
    <Button onClick={() => m.mutate()} disabled={m.isPending}>
      <Play className="h-4 w-4" /> {m.isPending ? "Dispatching…" : "Dispatch due"}
    </Button>
  );
}

function RowAction({ id, action, label, variant }: { id: string; action: "retry" | "discard"; label: string; variant: "default" | "danger" | "secondary" }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/admin/webhooks/${id}?action=${action}`, { method: "POST" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: () => {
      toast.success(action === "retry" ? "Re-queued for delivery" : "Discarded to DLQ");
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (e: Error) => toast.error("Action failed", { description: e.message }),
  });
  return (
    <Button size="sm" variant={variant} onClick={() => m.mutate()} disabled={m.isPending}>
      {action === "retry" ? <RotateCw className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />} {label}
    </Button>
  );
}

export default function WebhooksPage() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const q = useQuery({
    queryKey: ["webhooks"],
    queryFn: async () => (await fetch("/api/admin/webhooks").then((r) => r.json())) as {
      pending: OutboxRow[]; dlq: OutboxRow[]; recent: OutboxRow[]; configs: ConfigRow[];
    },
    refetchInterval: autoRefresh ? 4000 : false,
  });

  const pendingCols: Column<OutboxRow>[] = [
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
    { key: "event_type", header: "Event", render: (r) => <Badge variant="brand">{r.event_type}</Badge> },
    { key: "merchant_id", header: "Merchant", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    { key: "target_url", header: "Target", render: (r) => <span className="font-mono text-xs">{r.target_url.slice(0, 36)}</span> },
    { key: "attempts", header: "Attempts" },
    { key: "next_attempt_at", header: "Next try", render: (r) => formatDateTime(r.next_attempt_at) },
    { key: "last_error", header: "Last error", render: (r) => r.last_error ? <span className="text-xs text-[color:var(--color-danger)]">{r.last_error.slice(0, 40)}</span> : "—" },
    { key: "outbox_id", header: "Actions", render: (r) => (
      <div className="flex gap-1">
        <RowAction id={r.outbox_id} action="retry" label="Retry now" variant="secondary" />
        <RowAction id={r.outbox_id} action="discard" label="" variant="danger" />
      </div>
    )},
  ];

  const dlqCols: Column<OutboxRow>[] = [
    { key: "dead_lettered_at", header: "DLQ at", render: (r) => formatDateTime(r.dead_lettered_at!) },
    { key: "event_type", header: "Event", render: (r) => <Badge variant="danger">{r.event_type}</Badge> },
    { key: "merchant_id", header: "Merchant", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    { key: "attempts", header: "Attempts" },
    { key: "last_error", header: "Final error", render: (r) => <span className="text-xs text-[color:var(--color-danger)]">{r.last_error}</span> },
    { key: "target_url", header: "Target", render: (r) => <span className="font-mono text-xs">{r.target_url.slice(0, 36)}</span> },
    { key: "outbox_id", header: "Resurrect", render: (r) => <RowAction id={r.outbox_id} action="retry" label="Re-queue" variant="default" /> },
  ];

  const recentCols: Column<OutboxRow>[] = [
    { key: "delivered_at", header: "Delivered", render: (r) => formatDateTime(r.delivered_at!) },
    { key: "event_type", header: "Event" },
    { key: "merchant_id", header: "Merchant", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    { key: "attempts", header: "Attempts" },
    { key: "target_url", header: "Target", render: (r) => <span className="font-mono text-xs">{r.target_url.slice(0, 36)}</span> },
  ];

  const configCols: Column<ConfigRow>[] = [
    { key: "merchant_id", header: "Merchant" },
    { key: "target_url", header: "Target URL", render: (r) => <span className="font-mono text-xs">{r.target_url}</span> },
    { key: "enabled", header: "Enabled", render: (r) => r.enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
    { key: "updated_at", header: "Updated", render: (r) => formatDateTime(r.updated_at) },
  ];

  const pending = q.data?.pending ?? [];
  const dlq = q.data?.dlq ?? [];
  const recent = q.data?.recent ?? [];

  return (
    <>
      <PageHeader
        title="Merchant webhooks"
        description="Outbox + DLQ + dispatch (BRD §8 P4). Retry schedule 1m → 5m → 15m → 1h → 6h → 24h → DLQ."
        icon={Webhook}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="warning">{pending.length} pending</Badge>
            <Badge variant="danger"><AlertTriangle className="h-3 w-3" /> {dlq.length} DLQ</Badge>
            <Button size="sm" variant={autoRefresh ? "default" : "secondary"} onClick={() => setAutoRefresh((v) => !v)}>
              {autoRefresh ? "Live" : "Paused"}
            </Button>
            <DispatchButton />
          </div>
        }
      />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Pending / retrying ({pending.length})</CardTitle>
          <CardDescription>Click Dispatch due to drain rows whose next_attempt_at has elapsed.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable columns={pendingCols} rows={pending} rowKey={(r) => r.outbox_id} emptyState="Empty queue. Trigger a payment.succeeded event to enqueue." />
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Dead-letter queue ({dlq.length})</CardTitle>
          <CardDescription>Webhooks the platform could not deliver. Re-queue after operator review.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable columns={dlqCols} rows={dlq} rowKey={(r) => r.outbox_id} emptyState="No dead-lettered webhooks." />
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Recently delivered ({recent.length})</CardTitle></CardHeader>
        <CardContent>
          <DataTable columns={recentCols} rows={recent} rowKey={(r) => r.outbox_id} emptyState="Nothing delivered yet." />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Merchant webhook configs ({q.data?.configs.length ?? 0})</CardTitle>
          <CardDescription>Each merchant has one URL + signing secret. Edit via direct SQL until Sprint 5 surfaces config UI.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable columns={configCols} rows={q.data?.configs ?? []} rowKey={(r) => r.config_id} emptyState="No webhook configurations yet." />
        </CardContent>
      </Card>
    </>
  );
}
