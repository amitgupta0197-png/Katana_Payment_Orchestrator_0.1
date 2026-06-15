"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCheck2, ShieldCheck, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface KybCase {
  id: string; merchant_id: string; status: string; risk_tier?: string;
  opened_at: string; decided_at?: string; decided_by: string;
  screening_hits: number; doc_count: number;
}

function DecisionDialog({ kyb, decision }: { kyb: KybCase; decision: "APPROVED" | "REJECTED" }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [riskTier, setRiskTier] = useState<"LOW" | "MEDIUM" | "HIGH">(kyb.risk_tier as any ?? "LOW");
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/kyb/${kyb.id}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: decision, risk_tier: decision === "APPROVED" ? riskTier : undefined, notes }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success(`Case ${decision}`);
      setOpen(false); setNotes("");
      qc.invalidateQueries({ queryKey: ["kyb:admin"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={decision === "APPROVED" ? "default" : "danger"}>
          {decision === "APPROVED" ? <><ShieldCheck className="h-4 w-4" /> Approve</> : <><AlertTriangle className="h-4 w-4" /> Reject</>}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{decision === "APPROVED" ? "Approve" : "Reject"} KYB case</DialogTitle>
          <DialogDescription>
            Merchant {kyb.merchant_id} · {kyb.screening_hits} screening hits · {kyb.doc_count} documents.
            {kyb.screening_hits > 0 && decision === "APPROVED" && (
              <span className="block mt-1 text-[color:var(--color-danger)]">
                ⚠ Screening hits {">"} 0 blocks APPROVED per §3.10 — proceed only with documented override.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {decision === "APPROVED" && (
            <div className="space-y-1.5">
              <Label>Risk tier</Label>
              <select className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]" value={riskTier} onChange={(e) => setRiskTier(e.target.value as any)}>
                <option value="LOW">LOW</option><option value="MEDIUM">MEDIUM</option><option value="HIGH">HIGH</option>
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Decision notes</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. 'docs verified, no sanctions hit'" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending} variant={decision === "APPROVED" ? "default" : "danger"}>
            {m.isPending ? "Submitting…" : `Confirm ${decision}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function KybPage() {
  const q = useQuery({
    queryKey: ["kyb:admin"],
    queryFn: async () => (await fetch("/api/kyb").then((r) => r.json())) as { cases: KybCase[] },
  });
  const cols: Column<KybCase>[] = [
    { key: "merchant_id", header: "Merchant" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "risk_tier", header: "Risk", render: (r) => r.risk_tier ? <Badge variant={statusVariant(r.risk_tier)}>{r.risk_tier}</Badge> : "—" },
    { key: "doc_count", header: "Docs" },
    { key: "screening_hits", header: "Hits", render: (r) => r.screening_hits > 0 ? <Badge variant="danger">{r.screening_hits}</Badge> : <Badge variant="success">0</Badge> },
    { key: "opened_at", header: "Opened", render: (r) => formatDateTime(r.opened_at) },
    { key: "decided_at", header: "Decided", render: (r) => r.decided_at ? formatDateTime(r.decided_at) : "—" },
    {
      key: "actions", header: "",
      render: (r) =>
        r.status === "APPROVED" || r.status === "REJECTED" || r.status === "EXPIRED"
          ? <span className="text-xs text-[color:var(--color-text-subtle)]">{r.status}</span>
          : <div className="flex gap-2"><DecisionDialog kyb={r} decision="APPROVED" /><DecisionDialog kyb={r} decision="REJECTED" /></div>,
    },
  ];
  return (
    <>
      <PageHeader title="KYB" description="Payments-specific KYB cases (PRODUCT_VISION §3.10). Approve / reject with risk-tier assignment and audit notes." icon={FileCheck2} />
      <Card><CardHeader><CardTitle>{(q.data?.cases ?? []).length} cases</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.cases ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No KYB cases." /></CardContent>
      </Card>
    </>
  );
}
