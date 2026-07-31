"use client";

// L1 — Sub-MID engine. Main MIDs stay as a compact section; Sub-MIDs get
// the DataView treatment (KYC filter chips, settle-on/off chips, search by
// code/merchant, row links to /sub-mids/[id]).

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Network, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface SubMid {
  id: string; sub_mid_code: string; traffic_mode: string; kyc_status: string;
  settlement_enabled: boolean; merchant_id: string; main_mid_code: string; requested_at: string;
  provider_id?: string;
}
interface MainMid { id: string; mid_code: string; merchant_id: string; sub_mid_count: number; settlement_enabled: boolean }
interface Provider { id: string; code: string; legal_name: string }

// A sub-MID hangs off a main MID, which belongs to a merchant. Main MID creation is
// super-admin only (§2.2 step 6) and had no UI until now — exposed here so a sub-MID
// can be onboarded end-to-end from this section.
function CreateMainMidDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ merchant_id: "", mid_code: "" });
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/sub-mids", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "create_main_mid", ...form }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Main MID created"); onOpenChange(false); qc.invalidateQueries({ queryKey: ["sub-mids"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New main MID</DialogTitle>
          <DialogDescription>A merchant&apos;s primary MID. Sub-MIDs are then onboarded under it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Branch code</Label>
            <Input value={form.merchant_id} onChange={(e) => setForm({ ...form, merchant_id: e.target.value.toUpperCase() })} placeholder="M-0001" />
          </div>
          <div className="space-y-1.5">
            <Label>MID code</Label>
            <Input value={form.mid_code} onChange={(e) => setForm({ ...form, mid_code: e.target.value.toUpperCase() })} placeholder="MID-0001" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !form.merchant_id || !form.mid_code}>
            {m.isPending ? "Creating…" : "Create main MID"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OnboardSubMidDialog({ open, onOpenChange, mains }: { open: boolean; onOpenChange: (o: boolean) => void; mains: MainMid[] }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ main_mid_code: "", sub_mid_code: "", traffic_mode: "TRAFFIC", provider_id: "" });
  const providersQ = useQuery({
    queryKey: ["providers"],
    enabled: open,
    queryFn: async () => {
      const r = await fetch("/api/providers");
      if (!r.ok) return { providers: [] as Provider[] };
      return (await r.json()) as { providers: Provider[] };
    },
  });
  const providers = providersQ.data?.providers ?? [];
  const selectedMain = mains.find((mm) => mm.mid_code === form.main_mid_code);
  const m = useMutation({
    mutationFn: async () => {
      if (!selectedMain) throw new Error("Select a main MID");
      const r = await fetch("/api/sub-mids", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "create_sub_mid",
          main_mid_code: form.main_mid_code,
          merchant_id: selectedMain.merchant_id,
          sub_mid_code: form.sub_mid_code,
          traffic_mode: form.traffic_mode,
          provider_id: form.provider_id || undefined,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Sub-MID onboarded — PENDING KYC"); onOpenChange(false); qc.invalidateQueries({ queryKey: ["sub-mids"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const selClass = "flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Onboard sub-MID</DialogTitle>
          <DialogDescription>Starts at PENDING KYC, settlement off. Optionally map it to the sourcing provider.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Main MID</Label>
            <select className={selClass} value={form.main_mid_code} onChange={(e) => setForm({ ...form, main_mid_code: e.target.value })}>
              <option value="">— Select a main MID —</option>
              {mains.map((mm) => (
                <option key={mm.id} value={mm.mid_code}>{mm.mid_code} · {mm.merchant_id}</option>
              ))}
            </select>
            {selectedMain && <p className="text-xs text-[color:var(--color-text-muted)]">Branch: <span className="font-mono">{selectedMain.merchant_id}</span></p>}
          </div>
          <div className="space-y-1.5">
            <Label>Sub-MID code</Label>
            <Input value={form.sub_mid_code} onChange={(e) => setForm({ ...form, sub_mid_code: e.target.value.toUpperCase() })} placeholder="SUB-0001" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Traffic mode</Label>
              <select className={selClass} value={form.traffic_mode} onChange={(e) => setForm({ ...form, traffic_mode: e.target.value })}>
                {["TRAFFIC", "KYC_APPROVED"].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Provider <span className="font-normal text-[color:var(--color-text-muted)]">(optional)</span></Label>
              <select className={selClass} value={form.provider_id} onChange={(e) => setForm({ ...form, provider_id: e.target.value })}>
                <option value="">— None —</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.legal_name}</option>)}
              </select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !form.main_mid_code || !form.sub_mid_code}>
            {m.isPending ? "Onboarding…" : "Onboard sub-MID"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminSubMidsPage() {
  const [mainOpen, setMainOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const q = useQuery({
    queryKey: ["sub-mids"],
    queryFn: async () => (await fetch("/api/sub-mids").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { main_mids: MainMid[]; sub_mids: SubMid[] },
  });
  const main = q.data?.main_mids ?? [];
  const sub = q.data?.sub_mids ?? [];

  const mainCols: Column<MainMid>[] = [
    { key: "mid_code", header: "MID code" },
    { key: "merchant_id", header: "Branch" },
    { key: "sub_mid_count", header: "Sub-MIDs", render: (r) => <span className="tabular-nums">{r.sub_mid_count}</span> },
    { key: "settlement_enabled", header: "Settle?", render: (r) => r.settlement_enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];
  const subCols: Column<SubMid>[] = [
    { key: "sub_mid_code", header: "Sub-MID",
      render: (r) => <Link className="text-[color:var(--color-brand)] hover:underline font-medium" href={`/sub-mids/${r.id}`}>{r.sub_mid_code}</Link> },
    { key: "main_mid_code", header: "Main MID" },
    { key: "merchant_id", header: "Branch", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    { key: "traffic_mode", header: "Mode", render: (r) => <Badge variant={statusVariant(r.traffic_mode)}>{r.traffic_mode}</Badge> },
    { key: "kyc_status", header: "KYC", render: (r) => <Badge variant={statusVariant(r.kyc_status)}>{r.kyc_status}</Badge> },
    { key: "settlement_enabled", header: "Settle?", render: (r) => r.settlement_enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
    { key: "requested_at", header: "Requested", render: (r) => <span className="text-xs">{formatDateTime(r.requested_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="Main + Sub-MID engine" description="MID surface for all branches (PRODUCT_VISION §3.2)." icon={Network} />

      <div className="mb-4 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setMainOpen(true)}><Plus /> New main MID</Button>
        <Button onClick={() => setSubOpen(true)} disabled={main.length === 0}><Plus /> Onboard sub-MID</Button>
        {main.length === 0 && (
          <span className="self-center text-xs text-[color:var(--color-text-muted)]">Create a main MID first to onboard sub-MIDs.</span>
        )}
      </div>

      <Card className="mb-6">
        <CardHeader><CardTitle className="text-base">Main MIDs ({main.length})</CardTitle></CardHeader>
        <CardContent>
          <DataTable columns={mainCols} rows={main} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No main MIDs." />
        </CardContent>
      </Card>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Sub-MIDs ({sub.length})</h2>
      <DataView
        rows={sub}
        columns={subCols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        href={(r) => `/sub-mids/${r.id}`}
        search={{ placeholder: "Search by sub-MID / main MID / branch…", fields: ["sub_mid_code", "main_mid_code", "merchant_id"] }}
        filters={[
          { key: "kyc-pending",  label: "KYC pending",   predicate: (r: SubMid) => r.kyc_status === "PENDING" || r.kyc_status === "IN_REVIEW" },
          { key: "kyc-approved", label: "KYC approved",  predicate: (r: SubMid) => r.kyc_status === "APPROVED" },
          { key: "live",         label: "Settling",      predicate: (r: SubMid) => r.settlement_enabled },
          { key: "traffic",      label: "Traffic mode",  predicate: (r: SubMid) => r.traffic_mode === "TRAFFIC" || r.traffic_mode === "LIVE" },
        ]}
        savedViewKey="sub-mids"
        refresh={() => q.refetch()}
        emptyTitle="No Sub-MIDs yet"
        emptyDescription="Onboard a Sub-MID above (or from a merchant's detail page) to start traffic-mode rollout."
      />

      <CreateMainMidDialog open={mainOpen} onOpenChange={setMainOpen} />
      <OnboardSubMidDialog open={subOpen} onOpenChange={setSubOpen} mains={main} />
    </>
  );
}
