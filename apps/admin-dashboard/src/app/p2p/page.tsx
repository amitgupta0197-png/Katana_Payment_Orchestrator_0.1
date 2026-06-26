"use client";

// P2P Traders — Individual + Business. List + onboard. Detail handles VPAs,
// limits, sub-users, and UTR-matched collections.

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Trader {
  id: string; trader_code: string; name: string; kind: string; status: string; risk_tier: string;
  per_txn_max: number; daily_amount_max: number; vpa_mode: string; vpa_count: number;
  today_gross: number; today_count: number; created_at: string;
}

function CreateTrader() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ trader_code: "", name: "", kind: "INDIVIDUAL", contact_email: "", contact_phone: "", primary_vpa: "", vpa_mode: "STATIC", per_txn_max: "100000", daily_amount_max: "1000000" });
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/p2p/traders", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, contact_email: form.contact_email || undefined, primary_vpa: form.primary_vpa || undefined }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Trader onboarded"); setOpen(false); qc.invalidateQueries({ queryKey: ["p2p:traders"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const selClass = "flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]";
  const valid = form.trader_code.trim().length >= 2 && form.name.trim().length >= 2;
  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus /> Onboard trader</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Onboard P2P trader</DialogTitle>
            <DialogDescription>Individual trader or business pool. Set VPA mode + limits.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Trader code</Label><Input value={form.trader_code} onChange={(e) => setForm({ ...form, trader_code: e.target.value.toUpperCase() })} placeholder="TRD-0001" /></div>
            <div className="space-y-1.5"><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="space-y-1.5">
              <Label>Kind</Label>
              <select className={selClass} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="INDIVIDUAL">Individual</option>
                <option value="BUSINESS">Business (pool)</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>VPA mode</Label>
              <select className={selClass} value={form.vpa_mode} onChange={(e) => setForm({ ...form, vpa_mode: e.target.value })}>
                <option value="STATIC">Static</option>
                <option value="DYNAMIC">Dynamic</option>
              </select>
            </div>
            <div className="space-y-1.5"><Label>Primary VPA <span className="font-normal text-[color:var(--color-text-muted)]">(optional)</span></Label><Input value={form.primary_vpa} onChange={(e) => setForm({ ...form, primary_vpa: e.target.value })} placeholder="trader@upi" /></div>
            <div className="space-y-1.5"><Label>Contact email <span className="font-normal text-[color:var(--color-text-muted)]">(optional)</span></Label><Input type="email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Per-txn max</Label><Input type="number" value={form.per_txn_max} onChange={(e) => setForm({ ...form, per_txn_max: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Daily amount max</Label><Input type="number" value={form.daily_amount_max} onChange={(e) => setForm({ ...form, daily_amount_max: e.target.value })} /></div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => m.mutate()} disabled={m.isPending || !valid}>{m.isPending ? "Creating…" : "Onboard trader"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function P2PPage() {
  const q = useQuery({
    queryKey: ["p2p:traders"],
    queryFn: async () => (await fetch("/api/p2p/traders").then((r) => r.json())) as { traders: Trader[] },
    refetchInterval: 30_000,
  });
  const traders = q.data?.traders ?? [];

  const cols: Column<Trader>[] = [
    { key: "trader_code", header: "Code", render: (r) => <Link className="text-[color:var(--color-brand)] hover:underline font-medium" href={`/p2p/${r.id}`}>{r.trader_code}</Link> },
    { key: "name", header: "Name" },
    { key: "kind", header: "Kind", render: (r) => <Badge variant={r.kind === "BUSINESS" ? "info" : "default"}>{r.kind}</Badge> },
    { key: "vpa_mode", header: "VPA", render: (r) => <span>{r.vpa_mode.toLowerCase()} · {r.vpa_count}</span> },
    { key: "today_gross", header: "Today gross", render: (r) => <span className="tabular-nums">{formatAmount(r.today_gross)}</span> },
    { key: "today_count", header: "Today txns", render: (r) => <span className="tabular-nums">{r.today_count}</span> },
    { key: "risk_tier", header: "Risk", render: (r) => <Badge variant={statusVariant(r.risk_tier)}>{r.risk_tier}</Badge> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="P2P Traders" description="Individual traders + business pools. VPA mapping, limits, and UTR-matched collections." icon={Users} actions={<CreateTrader />} />
      <DataView
        rows={traders} columns={cols} rowKey={(r) => r.id} loading={q.isLoading}
        href={(r) => `/p2p/${r.id}`}
        search={{ placeholder: "Search by code / name…", fields: ["trader_code", "name", "kind"] }}
        filters={[
          { key: "individual", label: "Individual", predicate: (r: Trader) => r.kind === "INDIVIDUAL" },
          { key: "business", label: "Business", predicate: (r: Trader) => r.kind === "BUSINESS" },
          { key: "suspended", label: "Suspended", predicate: (r: Trader) => r.status !== "ACTIVE" },
        ]}
        savedViewKey="p2p-traders" refresh={() => q.refetch()}
        emptyTitle="No P2P traders yet" emptyDescription="Onboard an individual trader or a business pool to start."
      />
    </>
  );
}
