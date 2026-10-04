"use client";

// TSPs (technology service providers): the aggregators, gateways and acquiring-bank arms a bank
// issues MIDs through (Bank → TSP → Banker, lib/chain). Staff only.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { healthBand, TSP_STAGES, TSP_TYPES, type TspStage, type TspType } from "@/lib/chain";
import { cn, statusVariant } from "@/lib/utils";

interface TspListRow {
  id: string; code: string; name: string; tsp_type: TspType; stage: TspStage;
  confirmed_banks: number; bankers: number; live_bankers: number; active_mids: number; pending_requests: number; score: number;
}

const TSP_TYPE_LABEL: Record<TspType, string> = {
  PAYMENT_AGGREGATOR: "Payment aggregator", PAYMENT_GATEWAY: "Payment gateway", ACQUIRING_BANK_ARM: "Acquiring bank arm",
};
const STAGE_LABEL: Record<string, string> = {
  APPLICATION: "Application", KYB_PENDING: "KYB documents", SCREENING: "Screening", BANK_VERIFY: "Bank verify",
  CONFIG: "Configuration", LIVE: "Live", SUSPENDED: "Suspended", REJECTED: "Rejected",
};

function ScorePill({ score }: { score: number }) {
  const band = healthBand(score);
  const color = band === "GREEN" ? "var(--color-success)" : band === "AMBER" ? "var(--color-warning)" : "var(--color-danger)";
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums" title={`Checklist ${score}% done`}>
      <span className="relative h-5 w-5 rounded-full"
        style={{ background: `conic-gradient(${color} ${score * 3.6}deg, var(--color-border) 0deg)` }}>
        <span className="absolute inset-[3px] rounded-full bg-[color:var(--color-surface)]" />
      </span>
      <span className="text-xs font-medium" style={{ color }}>{score}%</span>
    </span>
  );
}

async function readJson<T>(r: Response): Promise<T> {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
  return d as T;
}

const selectCls = "flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]";

function NewTspDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [f, setF] = useState({ code: "", name: "", tsp_type: "PAYMENT_AGGREGATOR" as TspType, legal_name: "", gateway_code: "" });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const m = useMutation({
    mutationFn: async () => readJson<{ id: string }>(await fetch("/api/tsps", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: f.code.trim().toUpperCase(), name: f.name.trim(), tsp_type: f.tsp_type,
        legal_name: f.legal_name.trim() || null, gateway_code: f.gateway_code.trim() || null,
      }),
    })),
    onSuccess: (d) => {
      toast.success(`TSP ${f.code.toUpperCase()} added`);
      qc.invalidateQueries({ queryKey: ["tsps"] });
      onOpenChange(false);
      router.push(`/tsps/${d.id}`);
    },
    onError: (e: Error) => toast.error("Could not add the TSP", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New TSP</DialogTitle>
          <DialogDescription>It starts at Application. You can fill in the rest on its page.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tsp-code">Code</Label>
              <Input id="tsp-code" value={f.code} onChange={(e) => set("code", e.target.value.toUpperCase())} placeholder="e.g. RAZORPAY" maxLength={20} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tsp-name">Name</Label>
              <Input id="tsp-name" value={f.name} onChange={(e) => set("name", e.target.value)} required />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tsp-type">Type</Label>
            <select id="tsp-type" className={selectCls} value={f.tsp_type} onChange={(e) => set("tsp_type", e.target.value)}>
              {TSP_TYPES.map((t) => <option key={t} value={t}>{TSP_TYPE_LABEL[t]}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tsp-legal">Legal name</Label>
            <Input id="tsp-legal" value={f.legal_name} onChange={(e) => set("legal_name", e.target.value)} placeholder="As on the certificate of incorporation" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tsp-gw">Gateway code (optional)</Label>
            <Input id="tsp-gw" value={f.gateway_code} onChange={(e) => set("gateway_code", e.target.value)} placeholder="The connector this TSP runs on, if any" />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={m.isPending || !f.code.trim() || !f.name.trim()}>{m.isPending ? "Adding…" : "Add TSP"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function TspsPage() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ["tsps"], queryFn: async () => readJson<{ tsps: TspListRow[] }>(await fetch("/api/tsps")) });
  const list = q.data?.tsps ?? [];
  const funnel: { stage: string; n: number }[] = [
    ...TSP_STAGES.map((s) => ({ stage: s as string, n: list.filter((t) => t.stage === s).length })),
    { stage: "SUSPENDED", n: list.filter((t) => t.stage === "SUSPENDED").length },
  ];

  const columns: Column<TspListRow>[] = [
    { key: "code", header: "Code", render: (t) => <span className="font-mono font-medium">{t.code}</span> },
    { key: "name", header: "Name" },
    { key: "tsp_type", header: "Type", render: (t) => TSP_TYPE_LABEL[t.tsp_type] ?? t.tsp_type },
    { key: "stage", header: "Stage", render: (t) => <Badge variant={statusVariant(t.stage)}>{STAGE_LABEL[t.stage] ?? t.stage}</Badge> },
    { key: "score", header: "Checklist", render: (t) => <ScorePill score={t.score} /> },
    { key: "confirmed_banks", header: "Banks", className: "text-right tabular-nums" },
    { key: "bankers", header: "Bankers (live)", className: "text-right tabular-nums", render: (t) => `${t.live_bankers} / ${t.bankers}` },
    { key: "active_mids", header: "Active MIDs", className: "text-right tabular-nums" },
    { key: "pending_requests", header: "Waiting approval", className: "text-right tabular-nums",
      render: (t) => t.pending_requests > 0 ? <Badge variant="warning">{t.pending_requests}</Badge> : <span className="text-[color:var(--color-text-muted)]">0</span> },
  ];

  return (
    <div>
      <PageHeader title="TSPs / Providers" icon={Building2}
        description="The aggregators, gateways and bank arms that banks issue MIDs through, and how far each is onboarded."
        actions={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New TSP</Button>} />

      <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7" aria-label="TSPs per stage">
        {funnel.map((s) => (
          <div key={s.stage} className={cn("rounded-2xl border bg-[color:var(--color-surface)] px-3 py-2",
            s.stage === "SUSPENDED" && s.n > 0 && "border-[color:var(--color-danger)]/40")}>
            <div className="truncate text-xs text-[color:var(--color-text-muted)]">{STAGE_LABEL[s.stage]}</div>
            <div className="text-lg font-semibold tabular-nums">{q.isLoading ? "—" : s.n}</div>
          </div>
        ))}
      </div>

      <Card>
        <CardContent className="pt-6">
          {q.error ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p> : (
            <DataTable columns={columns} rows={list} loading={q.isLoading} rowKey={(t) => t.id}
              onRowClick={(t) => router.push(`/tsps/${t.id}`)}
              emptyState={<>No TSPs yet. A TSP is the aggregator, gateway or bank arm a bank issues a banker&apos;s MIDs through. Add one with &quot;New TSP&quot;.</>} />
          )}
        </CardContent>
      </Card>

      <NewTspDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
