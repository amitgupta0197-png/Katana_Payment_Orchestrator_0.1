"use client";

// L1 — webhooks cockpit. Tabbed (Configs / Pending / DLQ / Recent) mirroring
// the Axpay/Stripe Developers layout (Webhooks / Webhook Logs). Top-right
// "Create Webhook" dialog adds a merchant_webhook_config and reveals the
// signing secret ONCE so the merchant can configure signature verification.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Webhook, Play, RotateCw, Trash2, AlertTriangle, Plus, Copy, Link2, Power, PowerOff,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataView } from "@/components/world-class/data-view";
import { RowActions } from "@/components/world-class/row-actions";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { formatDateTime } from "@/lib/utils";

interface OutboxRow {
  outbox_id: string; merchant_id: string; order_id: string | null;
  event_type: string; target_url: string; status: string; attempts: number;
  last_error: string; next_attempt_at: string; created_at: string;
  delivered_at?: string; dead_lettered_at?: string;
  payload: Record<string, unknown>;
}
interface ConfigRow { config_id: string; merchant_id: string; target_url: string; enabled: boolean; updated_at: string }

const EVENT_TYPES = [
  "payment.success",
  "payment.failed",
  "refund.updated",
  "settlement.updated",
  "dispute.opened",
  "dispute.resolved",
];

function CreateWebhookDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    merchant_id: "M10001",
    target_url: "https://hooks.acme.example.com/katana",
    type: "payments",
    enabled: true,
    events: ["payment.success", "payment.failed"] as string[],
    remarks: "",
  });
  const [secret, setSecret] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/webhooks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant_id: form.merchant_id,
          target_url:  form.target_url,
          enabled:     form.enabled,
          events:      form.events,
          remarks:     form.remarks,
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body as { secret: string };
    },
    onSuccess: (b) => {
      toast.success("Webhook created");
      setSecret(b.secret);
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const close = () => { setSecret(null); onOpenChange(false); };

  const toggleEvent = (ev: string) =>
    setForm((f) => ({ ...f, events: f.events.includes(ev) ? f.events.filter((x) => x !== ev) : [...f.events, ev] }));

  return (
    <Dialog open={open} onOpenChange={(o) => o ? onOpenChange(true) : close()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{secret ? "Webhook created — copy your signing secret" : "Create Webhook"}</DialogTitle>
          <DialogDescription>
            {secret
              ? "This secret is shown ONCE. Use it to verify the X-Katana-Signature HMAC on incoming POST bodies."
              : "Posts a signed JSON payload to your URL on each event. Failed deliveries retry with backoff 1m → 5m → 15m → 1h → 6h → 24h → DLQ."}
          </DialogDescription>
        </DialogHeader>
        {secret ? (
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-[color:var(--color-text-muted)]">Signing secret</Label>
              <div className="mt-1 break-all rounded-md border bg-[color:var(--color-surface-muted)] p-3 font-mono text-xs">{secret}</div>
            </div>
            <Button variant="secondary" onClick={() => { navigator.clipboard.writeText(secret); toast.success("Secret copied"); }}>
              <Copy className="h-4 w-4" /> Copy secret
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Branch ID</Label>
                <Input value={form.merchant_id} onChange={(e) => setForm({ ...form, merchant_id: e.target.value })} placeholder="M10001" />
              </div>
              <div className="space-y-1.5">
                <Label>Type</Label>
                <select
                  className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]"
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                >
                  <option value="payments">payments</option>
                  <option value="refunds">refunds</option>
                  <option value="disputes">disputes</option>
                  <option value="settlement">settlement</option>
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Target URL</Label>
              <Input
                value={form.target_url}
                onChange={(e) => setForm({ ...form, target_url: e.target.value })}
                placeholder="https://hooks.acme.example.com/katana"
              />
              <p className="text-xs text-[color:var(--color-text-muted)]">
                Must be HTTPS. We POST a JSON body signed with HMAC-SHA256 in <code className="font-mono">X-Katana-Signature</code>.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Events</Label>
              <div className="flex flex-wrap gap-1.5">
                {EVENT_TYPES.map((ev) => {
                  const on = form.events.includes(ev);
                  return (
                    <button
                      key={ev}
                      type="button"
                      onClick={() => toggleEvent(ev)}
                      className={`rounded-full border px-2.5 py-0.5 text-xs ${on ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]" : "border-[color:var(--color-border)] text-[color:var(--color-text-muted)]"}`}
                    >
                      {ev}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Remarks (optional)</Label>
              <Input value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} placeholder="audit context" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                className="h-4 w-4 accent-[color:var(--color-brand)]"
              />
              Enabled on create
            </label>
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={close}>{secret ? "Done" : "Cancel"}</Button>
          {!secret && (
            <Button onClick={() => m.mutate()} disabled={m.isPending || !form.merchant_id || !form.target_url}>
              {m.isPending ? "Creating…" : "Create Webhook"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function WebhooksPage() {
  const qc = useQueryClient();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const q = useQuery({
    queryKey: ["webhooks"],
    queryFn: async () => (await fetch("/api/admin/webhooks").then((r) => r.json())) as {
      pending: OutboxRow[]; dlq: OutboxRow[]; recent: OutboxRow[]; configs: ConfigRow[];
    },
    refetchInterval: autoRefresh ? 4000 : false,
  });

  const dispatch = useMutation({
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

  const toggle = useMutation({
    mutationFn: async ({ config_id, enabled }: { config_id: string; enabled: boolean }) => {
      const r = await fetch(`/api/admin/webhooks?config_id=${config_id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["webhooks"] }),
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const removeCfg = useMutation({
    mutationFn: async (config_id: string) => {
      const r = await fetch(`/api/admin/webhooks?config_id=${config_id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Webhook deleted"); qc.invalidateQueries({ queryKey: ["webhooks"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const rowAction = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: "retry" | "discard" }) => {
      const r = await fetch(`/api/admin/webhooks/${id}?action=${action}`, { method: "POST" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: (_, v) => { toast.success(v.action === "retry" ? "Re-queued" : "Discarded to DLQ"); qc.invalidateQueries({ queryKey: ["webhooks"] }); },
    onError: (e: Error) => toast.error("Action failed", { description: e.message }),
  });

  const pending = q.data?.pending ?? [];
  const dlq = q.data?.dlq ?? [];
  const recent = q.data?.recent ?? [];
  const configs = q.data?.configs ?? [];

  const configCols: Column<ConfigRow>[] = [
    { key: "updated_at", header: "Created on",
      render: (r) => <div className="text-xs"><div>{formatDateTime(r.updated_at)}</div></div> },
    { key: "merchant_id", header: "Branch" },
    { key: "target_url", header: "URL",
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs truncate max-w-[26rem]">{r.target_url}</span>
          <button onClick={() => { navigator.clipboard.writeText(r.target_url); toast.success("URL copied"); }} className="text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]">
            <Copy className="h-3 w-3" />
          </button>
        </div>
      ) },
    { key: "enabled", header: "Status", render: (r) => r.enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];

  const pendingCols: Column<OutboxRow>[] = [
    { key: "created_at", header: "Created", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
    { key: "event_type", header: "Event", render: (r) => <Badge variant="brand">{r.event_type}</Badge> },
    { key: "merchant_id", header: "Branch", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    { key: "target_url", header: "Target", render: (r) => <span className="font-mono text-xs">{r.target_url.slice(0, 36)}</span> },
    { key: "attempts", header: "Attempts", render: (r) => <span className="tabular-nums">{r.attempts}</span> },
    { key: "next_attempt_at", header: "Next try", render: (r) => <span className="text-xs">{formatDateTime(r.next_attempt_at)}</span> },
    { key: "last_error", header: "Last error", render: (r) => r.last_error ? <span className="text-xs text-[color:var(--color-danger)]">{r.last_error.slice(0, 40)}</span> : "—" },
  ];

  const dlqCols: Column<OutboxRow>[] = [
    { key: "dead_lettered_at", header: "DLQ at", render: (r) => <span className="text-xs">{formatDateTime(r.dead_lettered_at!)}</span> },
    { key: "event_type", header: "Event", render: (r) => <Badge variant="danger">{r.event_type}</Badge> },
    { key: "merchant_id", header: "Branch", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    { key: "attempts", header: "Attempts", render: (r) => <span className="tabular-nums">{r.attempts}</span> },
    { key: "last_error", header: "Final error", render: (r) => <span className="text-xs text-[color:var(--color-danger)]">{r.last_error}</span> },
    { key: "target_url", header: "Target", render: (r) => <span className="font-mono text-xs">{r.target_url.slice(0, 36)}</span> },
  ];

  const recentCols: Column<OutboxRow>[] = [
    { key: "delivered_at", header: "Delivered", render: (r) => <span className="text-xs">{formatDateTime(r.delivered_at!)}</span> },
    { key: "event_type", header: "Event" },
    { key: "merchant_id", header: "Branch", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    { key: "attempts", header: "Attempts", render: (r) => <span className="tabular-nums">{r.attempts}</span> },
    { key: "target_url", header: "Target", render: (r) => <span className="font-mono text-xs">{r.target_url.slice(0, 36)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Developers · Webhooks"
        description="Webhooks let your server receive real-time updates. Retry schedule 1m → 5m → 15m → 1h → 6h → 24h → DLQ (BRD §8 P4)."
        icon={Webhook}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={autoRefresh ? "info" : "default"}>
              <RotateCw className="h-3 w-3 mr-1" />{autoRefresh ? "live" : "paused"}
            </Badge>
            <Button size="sm" variant="secondary" onClick={() => setAutoRefresh((v) => !v)}>
              {autoRefresh ? "Pause" : "Live"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => dispatch.mutate()} disabled={dispatch.isPending}>
              <Play className="h-3.5 w-3.5" /> {dispatch.isPending ? "Dispatching…" : "Dispatch due"}
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> Create Webhook
            </Button>
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Configs" value={configs.length} loading={q.isLoading} />
        <KpiTile label="Pending" value={pending.length} variant={pending.length > 0 ? "warning" : "default"} loading={q.isLoading} />
        <KpiTile label="DLQ" value={dlq.length} variant={dlq.length > 0 ? "danger" : "default"} loading={q.isLoading} />
        <KpiTile label="Recently delivered" value={recent.length} variant="success" loading={q.isLoading} />
      </div>

      <Tabs defaultValue="configs">
        <TabsList>
          <TabsTrigger value="configs"><Link2 className="h-3.5 w-3.5" /> Webhooks
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{configs.length}</span>
          </TabsTrigger>
          <TabsTrigger value="pending">Pending
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{pending.length}</span>
          </TabsTrigger>
          <TabsTrigger value="dlq"><AlertTriangle className="h-3.5 w-3.5" /> DLQ
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{dlq.length}</span>
          </TabsTrigger>
          <TabsTrigger value="recent">Webhook Logs
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{recent.length}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="configs">
          <DataView rows={configs} columns={configCols} rowKey={(r) => r.config_id} loading={q.isLoading}
            search={{ placeholder: "Search by branch id or URL…", fields: ["merchant_id", "target_url"] }}
            filters={[
              { key: "on",  label: "Enabled",  predicate: (r: ConfigRow) => r.enabled },
              { key: "off", label: "Disabled", predicate: (r: ConfigRow) => !r.enabled },
            ]}
            savedViewKey="webhooks-configs" refresh={() => q.refetch()}
            emptyTitle="No webhooks configured yet"
            emptyDescription="Click Create Webhook to subscribe a merchant URL to platform events."
            rowActions={(r) => (
              <RowActions
                actions={[
                  { label: "Copy URL", icon: Copy, onClick: () => { navigator.clipboard.writeText(r.target_url); toast.success("URL copied"); } },
                  r.enabled
                    ? { label: "Disable", icon: PowerOff, onClick: () => toggle.mutate({ config_id: r.config_id, enabled: false }) }
                    : { label: "Enable",  icon: Power,    onClick: () => toggle.mutate({ config_id: r.config_id, enabled: true }) },
                  { label: "Delete", icon: Trash2, variant: "danger" as const,
                    onClick: () => { if (confirm(`Delete webhook for ${r.merchant_id}?`)) removeCfg.mutate(r.config_id); } },
                ]}
              />
            )}
          />
        </TabsContent>

        <TabsContent value="pending">
          <DataView rows={pending} columns={pendingCols} rowKey={(r) => r.outbox_id} loading={q.isLoading}
            search={{ placeholder: "Search by event / branch…", fields: ["event_type", "merchant_id", "target_url"] }}
            savedViewKey="webhooks-pending"
            emptyTitle="Queue is empty" emptyDescription="Trigger any merchant-bound event to enqueue."
            rowActions={(r) => (
              <RowActions actions={[
                { label: "Retry now", icon: RotateCw, onClick: () => rowAction.mutate({ id: r.outbox_id, action: "retry" }) },
                { label: "Discard to DLQ", icon: Trash2, variant: "danger" as const,
                  onClick: () => rowAction.mutate({ id: r.outbox_id, action: "discard" }) },
              ]} />
            )}
          />
        </TabsContent>

        <TabsContent value="dlq">
          <DataView rows={dlq} columns={dlqCols} rowKey={(r) => r.outbox_id}
            search={{ placeholder: "Search DLQ…", fields: ["event_type", "merchant_id", "last_error"] }}
            savedViewKey="webhooks-dlq"
            emptyTitle="DLQ is empty"
            rowActions={(r) => (
              <RowActions actions={[
                { label: "Re-queue", icon: RotateCw, onClick: () => rowAction.mutate({ id: r.outbox_id, action: "retry" }) },
              ]} />
            )}
          />
        </TabsContent>

        <TabsContent value="recent">
          <DataView rows={recent} columns={recentCols} rowKey={(r) => r.outbox_id}
            search={{ placeholder: "Search delivered events…", fields: ["event_type", "merchant_id"] }}
            savedViewKey="webhooks-recent"
            emptyTitle="No deliveries yet" />
        </TabsContent>
      </Tabs>

      <CreateWebhookDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
