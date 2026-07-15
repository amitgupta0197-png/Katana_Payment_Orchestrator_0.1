"use client";

// DT Refills (BRD §16). All bankers' refill requests — raised by bankers from the
// banker portal (or auto on exhaustion) — with the funding/verification lifecycle:
// OPEN → FUNDED → VERIFIED → CLOSED (CANCELLED while not yet verified).

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Droplets, Banknote, ShieldCheck, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { DataView } from "@/components/world-class/data-view";
import { RowActions } from "@/components/world-class/row-actions";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { formatDateTime } from "@/lib/utils";

interface Refill {
  id: string; banker_id: string; quantity: number | null; trigger: string; status: string;
  expiry: string | null; created_by: string; created_at: string;
}

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

  const transition = useMutation({
    mutationFn: async ({ id, to }: { id: string; to: string }) => {
      const r = await fetch(`/api/v1/dt/refills/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
    },
    onSuccess: () => { toast.success("Refill updated"); qc.invalidateQueries({ queryKey: ["dt-refills"] }); },
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
