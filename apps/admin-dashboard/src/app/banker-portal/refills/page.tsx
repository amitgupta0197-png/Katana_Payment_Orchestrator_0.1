"use client";

// Banker refills — the banker's own refill requests (BRD §16) plus a self-serve
// "request refill" action when their traffic quota is running low.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Droplets, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { DataView } from "@/components/world-class/data-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { Column } from "@/components/ui/data-table";
import { formatDateTime } from "@/lib/utils";

interface Refill {
  id: string; quantity: number | null; trigger: string; status: string;
  expiry: string | null; created_by: string; created_at: string;
}

const STATUS_VARIANT: Record<string, "default" | "info" | "warning" | "success" | "danger"> = {
  OPEN: "warning", FUNDED: "info", VERIFIED: "success", CLOSED: "default", CANCELLED: "danger",
};

export default function BankerRefillsPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["banker-refills"],
    queryFn: async () => {
      const r = await fetch("/api/banker-portal/refills");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d.refills as Refill[];
    },
  });

  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState("");
  const create = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      if (quantity.trim()) body.quantity = Number(quantity);
      const r = await fetch("/api/banker-portal/refills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
    },
    onSuccess: () => { toast.success("Refill requested"); setOpen(false); setQuantity(""); qc.invalidateQueries({ queryKey: ["banker-refills"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const cols: Column<Refill>[] = [
    { key: "quantity", header: "DT Qty", render: (r) => r.quantity != null ? r.quantity.toLocaleString("en-IN") : "—" },
    { key: "trigger", header: "Trigger", render: (r) => <Badge variant="default">{r.trigger}</Badge> },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>{r.status}</Badge> },
    { key: "created_by", header: "Raised by", render: (r) => r.created_by || "—" },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  return (
    <>
      <PageHeader title="Refills" description="Refill requests against your DT quota. Funding and verification happen on Katana's side." icon={Droplets} />
      <DataView
        rows={q.data ?? []}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        fab={{ label: "Request refill", icon: Plus, onClick: () => setOpen(true) }}
        refresh={() => q.refetch()}
        emptyTitle="No refill requests"
        emptyDescription="Raise a refill request when your traffic quota is running low."
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request refill</DialogTitle>
            <DialogDescription>Opens a manual refill request for Katana finance to fund and verify.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>DT quantity <span className="text-[color:var(--color-text-subtle)]">(optional)</span></Label>
            <Input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="e.g. 2000" />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending}>{create.isPending ? "Requesting…" : "Request refill"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
