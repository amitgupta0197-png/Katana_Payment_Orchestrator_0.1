"use client";

// DT Refills (BRD §16). All bankers' refill requests — raised by bankers from the
// banker portal (or auto on exhaustion) — with the funding/verification lifecycle:
// OPEN → FUNDED → VERIFIED → CLOSED (CANCELLED while not yet verified).

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Droplets, Banknote, ShieldCheck, CheckCircle2, XCircle, AlertTriangle, Bell } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { DataView } from "@/components/world-class/data-view";
import { RowActions } from "@/components/world-class/row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import type { Column } from "@/components/ui/data-table";
import { formatDateTime, formatAmount } from "@/lib/utils";

interface Refill {
  id: string; banker_id: string; quantity: number | null; trigger: string; status: string;
  expiry: string | null; created_by: string; created_at: string;
}

interface Alert {
  banker_id: string; level: "PAUSE" | "REFILL" | "WARN" | "OK";
  allocated: number; available: number; available_pct: number; open_refills: number;
  funding_overdue: boolean; overdue_hours: number | null; action: string; recipients: string[];
}

const LEVEL_VARIANT: Record<string, "default" | "info" | "warning" | "success" | "danger"> = {
  PAUSE: "danger", REFILL: "danger", WARN: "warning", OK: "success",
};

const STATUS_VARIANT: Record<string, "default" | "info" | "warning" | "success" | "danger"> = {
  OPEN: "warning", FUNDED: "info", VERIFIED: "success", CLOSED: "default", CANCELLED: "danger",
};

export default function DtRefillsPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["dt-refills"],
    queryFn: async () => {
      const r = await fetch("/api/v1/dt/refills");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d.refills as Refill[];
    },
  });

  // BRD §16 alert ladder, evaluated server-side against each banker's remaining quota.
  const alertsQ = useQuery({
    queryKey: ["dt-alerts"],
    queryFn: async () => {
      const r = await fetch("/api/v1/dt/alerts");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as { alerts: Alert[]; summary: { pause: number; refill: number; warn: number; overdue: number } };
    },
  });

  // Manual trigger for the same job the cron runs — idempotent, so an impatient
  // operator pressing it twice cannot create duplicate requests.
  const suggest = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/v1/dt/alerts", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as { created: string[]; skipped: string[] };
    },
    onSuccess: (d) => {
      if (d.created.length === 0) {
        toast.success("Nothing to raise", {
          description: d.skipped.length ? `${d.skipped.length} banker(s) already have an open request.` : "No banker is below the 15% threshold.",
        });
      } else {
        toast.success(`Raised ${d.created.length} refill request(s)`, { description: d.created.join(", ") });
      }
      qc.invalidateQueries({ queryKey: ["dt-refills"] });
      qc.invalidateQueries({ queryKey: ["dt-alerts"] });
    },
    onError: (e: Error) => toast.error("Could not raise refills", { description: e.message }),
  });

  const transition = useMutation({
    mutationFn: async ({ id, to }: { id: string; to: string }) => {
      const r = await fetch(`/api/v1/dt/refills/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as { rotation?: { total: number; traffic_quota: number; new_reserve: number; released_previous: number; released_count: number } };
    },
    // Surface the rotation so a verified refill is traceable from the admin screen
    // rather than silently succeeding ("not able to trace the refill", client 2026-07-31).
    onSuccess: (d) => {
      const rot = d?.rotation;
      if (rot) {
        toast.success("Refill verified — reserve rotated", {
          description: `New lot ${formatAmount(rot.total)} → quota ${formatAmount(rot.traffic_quota)} · new reserve ${formatAmount(rot.new_reserve)} · released ${formatAmount(rot.released_previous)} from ${rot.released_count} prior lot(s)`,
        });
      } else {
        toast.success("Refill updated");
      }
      qc.invalidateQueries({ queryKey: ["dt-refills"] });
    },
    onError: (e: Error) => toast.error("Transition failed", { description: e.message }),
  });

  const cols: Column<Refill>[] = [
    { key: "banker_id", header: "Banker", render: (r) => <span className="font-medium">{r.banker_id}</span> },
    { key: "quantity", header: "DT Qty", render: (r) => r.quantity != null ? r.quantity.toLocaleString("en-IN") : "—" },
    { key: "trigger", header: "Trigger", render: (r) => <Badge variant="default">{r.trigger}</Badge> },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>{r.status}</Badge> },
    { key: "created_by", header: "Raised by", render: (r) => r.created_by || "—" },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  function actionsFor(r: Refill) {
    const a: { label: string; icon: any; onClick: () => void; variant?: "danger" }[] = [];
    if (r.status === "OPEN") a.push({ label: "Mark funded", icon: Banknote, onClick: () => transition.mutate({ id: r.id, to: "FUNDED" }) });
    if (r.status === "FUNDED") a.push({ label: "Verify funds", icon: ShieldCheck, onClick: () => transition.mutate({ id: r.id, to: "VERIFIED" }) });
    if (r.status === "VERIFIED") a.push({ label: "Close", icon: CheckCircle2, onClick: () => transition.mutate({ id: r.id, to: "CLOSED" }) });
    if (r.status === "OPEN" || r.status === "FUNDED")
      a.push({ label: "Cancel", icon: XCircle, variant: "danger", onClick: () => { if (confirm(`Cancel refill request for ${r.banker_id}?`)) transition.mutate({ id: r.id, to: "CANCELLED" }); } });
    return a;
  }

  return (
    <>
      <PageHeader title="DT Refills" description="Banker refill requests and their funding/verification lifecycle (BRD §16)." icon={Droplets} />

      {/* BRD §16 alert board. Only bankers that actually breach a threshold are listed —
          a wall of green "OK" rows would bury the two that matter. */}
      {(() => {
        const breaching = (alertsQ.data?.alerts ?? []).filter((a) => a.level !== "OK" || a.funding_overdue);
        const s = alertsQ.data?.summary;
        return (
          <Card className="mb-5">
            <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Bell className="h-4 w-4" aria-hidden />
                  Refill alerts
                </CardTitle>
                <CardDescription>
                  Thresholds: ≤20% warn · ≤15% raise refill · exhausted pauses the priority route (BRD §16).
                </CardDescription>
              </div>
              <Button
                variant="secondary"
                onClick={() => suggest.mutate()}
                disabled={suggest.isPending || alertsQ.isLoading}
              >
                {suggest.isPending ? "Raising…" : "Raise refills now"}
              </Button>
            </CardHeader>
            <CardContent>
              {alertsQ.isLoading ? (
                <div className="py-2 text-sm text-[color:var(--color-text-muted)]">Evaluating bankers…</div>
              ) : breaching.length === 0 ? (
                <div className="flex items-center gap-2 py-2 text-sm text-[color:var(--color-text-muted)]">
                  <CheckCircle2 className="h-4 w-4 text-[color:var(--color-success)]" aria-hidden />
                  All bankers above the 20% threshold
                  {s ? ` · ${alertsQ.data?.alerts.length ?? 0} evaluated` : ""}
                </div>
              ) : (
                <div className="space-y-2">
                  {breaching.map((a) => (
                    <div
                      key={a.banker_id}
                      className="flex flex-wrap items-center gap-3 rounded-md border border-[color:var(--color-border)] px-3 py-2"
                    >
                      <AlertTriangle
                        className={`h-4 w-4 shrink-0 ${a.level === "WARN" ? "text-[color:var(--color-warning)]" : "text-[color:var(--color-danger)]"}`}
                        aria-hidden
                      />
                      <span className="font-medium">{a.banker_id}</span>
                      <Badge variant={LEVEL_VARIANT[a.level] ?? "default"}>{a.level}</Badge>
                      <span className="text-sm text-[color:var(--color-text-muted)]">
                        {formatAmount(a.available)} of {formatAmount(a.allocated)} left · {a.available_pct}%
                      </span>
                      {a.funding_overdue && (
                        <Badge variant="warning">funding overdue {a.overdue_hours}h</Badge>
                      )}
                      {a.open_refills > 0 && <Badge variant="info">{a.open_refills} open</Badge>}
                      <span className="ml-auto text-xs text-[color:var(--color-text-subtle)]">
                        {a.action} → {a.recipients.join(", ")}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })()}

      <DataView
        rows={q.data ?? []}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search by banker…", fields: ["banker_id", "status", "trigger"] }}
        filters={[
          { key: "open", label: "Open", predicate: (r) => r.status === "OPEN" },
          { key: "funded", label: "Funded", predicate: (r) => r.status === "FUNDED" },
          { key: "verified", label: "Verified", predicate: (r) => r.status === "VERIFIED" },
        ]}
        refresh={() => q.refetch()}
        emptyTitle="No refill requests"
        emptyDescription="Requests raised by bankers (or auto on quota exhaustion) appear here."
        rowActions={(r) => <RowActions actions={actionsFor(r)} />}
      />
    </>
  );
}
