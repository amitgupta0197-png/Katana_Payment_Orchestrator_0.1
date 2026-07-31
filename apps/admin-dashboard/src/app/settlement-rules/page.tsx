"use client";

// ADMIN — Katana settlement rule engine. Configure the multi-layer commission applied
// when an upline (provider) raises a settlement: upline / Katana / downline percentages,
// fixed fee, GST, min/max clamps — global, per-provider, or per-branch. Rules are
// versioned: creating one supersedes (end-dates) the previous rule for the same scope;
// settlements always keep the breakdown they were raised with.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Percent, Plus, Activity } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface Rule {
  id: string; provider_id: string | null; provider_name?: string | null; provider_code?: string | null;
  merchant_key: string | null; upline_bps: number; katana_bps: number; downline_bps: number;
  fixed_fee: number; gst_bps: number; min_charge: number | null; max_charge: number | null;
  effective_from: string; effective_to: string | null; version: number; reason: string | null;
  created_by: string | null;
}

interface Provider { id: string; code: string; legal_name: string }

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const isActive = (r: Rule) => !r.effective_to || new Date(r.effective_to) > new Date();

export default function SettlementRulesPage() {
  const qc = useQueryClient();
  const rules = useQuery({
    queryKey: ["settlement-rules"],
    queryFn: async () => (await fetch("/api/settlement-rules").then((r) => r.json())) as { rules: Rule[] },
    refetchInterval: 30_000,
  });
  const providers = useQuery({
    queryKey: ["providers-for-rules"],
    queryFn: async () => (await fetch("/api/providers").then((r) => r.json())) as { providers: Provider[] },
  });
  const [createOpen, setCreateOpen] = useState(false);

  const list = rules.data?.rules ?? [];
  const active = list.filter(isActive);

  const cols: Column<Rule>[] = [
    { key: "scope", header: "Scope", render: (r) => (
      <span className="text-xs">
        {r.provider_id ? <span className="font-medium">{r.provider_name ?? r.provider_code ?? r.provider_id.slice(0, 8)}</span> : <Badge variant="brand">Global default</Badge>}
        {r.merchant_key ? <> · branch <span className="font-mono">{r.merchant_key}</span></> : r.provider_id ? " · all branches" : null}
      </span>
    ) },
    { key: "rates", header: "Upline / Katana / Downline", render: (r) => (
      <span className="tabular-nums text-xs">{pct(r.upline_bps)} / {pct(r.katana_bps)} / {pct(r.downline_bps)}</span>
    ) },
    { key: "fees", header: "Fixed · GST", render: (r) => (
      <span className="tabular-nums text-xs">{r.fixed_fee > 0 ? formatAmount(r.fixed_fee) : "—"} · {r.gst_bps > 0 ? pct(r.gst_bps) : "—"}</span>
    ) },
    { key: "clamp", header: "Min / Max charge", render: (r) => (
      <span className="tabular-nums text-xs">{r.min_charge != null ? formatAmount(r.min_charge) : "—"} / {r.max_charge != null ? formatAmount(r.max_charge) : "—"}</span>
    ) },
    { key: "version", header: "Ver", render: (r) => <span className="tabular-nums text-xs">v{r.version}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={isActive(r) ? "success" : "default"}>{isActive(r) ? "Active" : "Superseded"}</Badge> },
    { key: "from", header: "Effective", render: (r) => <span className="text-xs">{formatDateTime(r.effective_from)}{r.effective_to ? ` → ${formatDateTime(r.effective_to)}` : ""}</span> },
    { key: "reason", header: "Reason", render: (r) => <span className="text-xs text-[color:var(--color-text-muted)]">{r.reason ?? "—"}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Settlement rules"
        description="The commission engine applied when an upline raises a settlement — gross → upline/Katana/downline charges → net payable. Versioned; history never reprices."
        icon={Percent}
        actions={<div className="flex items-center gap-2">
          <Badge variant={rules.isFetching ? "info" : "default"}><Activity className="h-3 w-3 mr-1" />live</Badge>
          <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> New rule</Button>
        </div>}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Active rules</div><div className="text-2xl font-semibold tabular-nums">{active.length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Global default</div><div className="text-2xl font-semibold tabular-nums">{active.some((r) => !r.provider_id && !r.merchant_key) ? "Set" : "None"}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Total versions</div><div className="text-2xl font-semibold tabular-nums">{list.length}</div></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Rules</CardTitle><CardDescription>Most specific active rule wins: provider + branch → provider-wide → global default. No rule = zero charges (settles at gross).</CardDescription></CardHeader>
        <CardContent>
          <DataTable columns={cols} rows={list} rowKey={(r) => r.id} loading={rules.isLoading} emptyState="No rules configured — settlements currently pass through at gross with zero charges." />
        </CardContent>
      </Card>

      <CreateRuleDialog open={createOpen} onOpenChange={setCreateOpen} providers={providers.data?.providers ?? []}
        onDone={() => { setCreateOpen(false); qc.invalidateQueries({ queryKey: ["settlement-rules"] }); }} />
    </>
  );
}

function CreateRuleDialog({ open, onOpenChange, providers, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; providers: Provider[]; onDone: () => void;
}) {
  const [form, setForm] = useState({
    provider_id: "", merchant_key: "", upline_pct: "", katana_pct: "", downline_pct: "",
    fixed_fee: "", gst_pct: "", min_charge: "", max_charge: "", reason: "",
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const toBps = (v: string) => Math.round(Number(v || 0) * 100);

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/settlement-rules", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider_id: form.provider_id || null,
          merchant_key: form.merchant_key || null,
          upline_bps: toBps(form.upline_pct), katana_bps: toBps(form.katana_pct), downline_bps: toBps(form.downline_pct),
          fixed_fee: Number(form.fixed_fee || 0), gst_bps: toBps(form.gst_pct),
          min_charge: form.min_charge ? Number(form.min_charge) : null,
          max_charge: form.max_charge ? Number(form.max_charge) : null,
          reason: form.reason,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as { version: number; superseded: number };
    },
    onSuccess: (d) => {
      toast.success(`Rule saved (v${d.version})`, { description: d.superseded ? "Previous rule superseded — history keeps its pricing." : "New scope." });
      onDone();
    },
    onError: (e: Error) => toast.error("Couldn’t save rule", { description: e.message }),
  });

  const totalPct = Number(form.upline_pct || 0) + Number(form.katana_pct || 0) + Number(form.downline_pct || 0);
  const example = 100000;
  const exCharge = (example * totalPct) / 100 + Number(form.fixed_fee || 0);
  const exGst = (exCharge * Number(form.gst_pct || 0)) / 100;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New settlement rule</DialogTitle>
          <DialogDescription>Creating a rule supersedes the previous one for the same scope (versioned). A reason is mandatory.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div><Label className="text-xs">Provider (blank = global)</Label>
            <select value={form.provider_id} onChange={(e) => set("provider_id", e.target.value)} className="w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm">
              <option value="">All providers (global)</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.legal_name} ({p.code})</option>)}
            </select></div>
          <div><Label className="text-xs">Branch code (blank = all)</Label><Input value={form.merchant_key} onChange={(e) => set("merchant_key", e.target.value)} placeholder="e.g. AMPL-01" /></div>
          <div><Label className="text-xs">Upline commission %</Label><Input type="number" step="0.01" value={form.upline_pct} onChange={(e) => set("upline_pct", e.target.value)} placeholder="5.75" /></div>
          <div><Label className="text-xs">Katana charge %</Label><Input type="number" step="0.01" value={form.katana_pct} onChange={(e) => set("katana_pct", e.target.value)} placeholder="0" /></div>
          <div><Label className="text-xs">Downline charge %</Label><Input type="number" step="0.01" value={form.downline_pct} onChange={(e) => set("downline_pct", e.target.value)} placeholder="0" /></div>
          <div><Label className="text-xs">Fixed fee (₹)</Label><Input type="number" step="0.01" value={form.fixed_fee} onChange={(e) => set("fixed_fee", e.target.value)} placeholder="0" /></div>
          <div><Label className="text-xs">GST on charges %</Label><Input type="number" step="0.01" value={form.gst_pct} onChange={(e) => set("gst_pct", e.target.value)} placeholder="18" /></div>
          <div><Label className="text-xs">Min charge (₹, optional)</Label><Input type="number" step="0.01" value={form.min_charge} onChange={(e) => set("min_charge", e.target.value)} /></div>
          <div><Label className="text-xs">Max charge (₹, optional)</Label><Input type="number" step="0.01" value={form.max_charge} onChange={(e) => set("max_charge", e.target.value)} /></div>
          <div className="col-span-2"><Label className="text-xs">Reason for this pricing (required)</Label><Input value={form.reason} onChange={(e) => set("reason", e.target.value)} placeholder="e.g. Q3 revised pricing for AMPL" /></div>
        </div>
        {totalPct > 0 && (
          <div className="rounded-md border bg-[color:var(--color-surface-muted)] p-2 text-xs text-[color:var(--color-text-muted)]">
            Example on {formatAmount(example)}: charges {formatAmount(Math.round((exCharge + exGst) * 100) / 100)} → net <span className="font-medium text-[color:var(--color-text)]">{formatAmount(Math.round((example - exCharge - exGst) * 100) / 100)}</span>
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || form.reason.trim().length < 3}>Save rule</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
