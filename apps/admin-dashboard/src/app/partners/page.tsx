"use client";

// Partners (lib/partner): payment aggregators that onboard their own merchants on Katana and take
// those merchants' payments through it. Staff only; a partner sees its own under its portal.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Handshake, Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { rupees } from "@/lib/plain-words";
import type { PartnerListRow } from "@/lib/partner/store";

async function readJson<T>(r: Response): Promise<T> {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
  return d as T;
}

const selectCls = "flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]";

function NewPartnerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [f, setF] = useState({ provider_id: "", code: "", name: "", own_gateway: "", exclusive: true, auto_approve: false });
  const candidates = useQuery({
    queryKey: ["partner-candidates"], enabled: open,
    queryFn: async () => readJson<{ candidates: { id: string; code: string | null; legal_name: string | null; status: string | null }[] }>(await fetch("/api/partners?candidates=1")),
  });
  const m = useMutation({
    mutationFn: async () => readJson<{ id: string }>(await fetch("/api/partners", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...f, name: f.name.trim() || null, own_gateway: f.own_gateway.trim() || null }),
    })),
    onSuccess: (d) => {
      toast.success(`${f.code} is now a partner`);
      qc.invalidateQueries({ queryKey: ["partners"] });
      onOpenChange(false);
      router.push(`/partners/${d.id}`);
    },
    onError: (e: Error) => toast.error("Not made a partner", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New partner</DialogTitle>
          <DialogDescription>
            A partner is an existing merchant. Its bankers take the money and it is settled as any merchant is; its own merchants are added under it.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <div className="space-y-1.5">
            <Label htmlFor="np-provider">Merchant</Label>
            <select id="np-provider" className={selectCls} value={f.provider_id} required
              onChange={(e) => {
                const c = candidates.data?.candidates.find((x) => x.id === e.target.value);
                setF((p) => ({ ...p, provider_id: e.target.value, code: p.code || (c?.code ?? "").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 20), name: p.name || (c?.legal_name ?? "") }));
              }}>
              <option value="">{candidates.isLoading ? "Loading…" : "Choose a merchant"}</option>
              {(candidates.data?.candidates ?? []).map((c) => <option key={c.id} value={c.id}>{c.legal_name ?? c.code} {c.code ? `(${c.code})` : ""}</option>)}
            </select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="np-code">Partner code</Label>
              <Input id="np-code" value={f.code} onChange={(e) => setF((p) => ({ ...p, code: e.target.value.toUpperCase() }))} placeholder="e.g. PAYATOM" maxLength={20} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-name">Name</Label>
              <Input id="np-name" value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-gw">The partner&apos;s own gateway (optional)</Label>
            <Input id="np-gw" value={f.own_gateway} onChange={(e) => setF((p) => ({ ...p, own_gateway: e.target.value.toUpperCase() }))} placeholder="e.g. PAYATOM" />
            <p className="text-xs text-[color:var(--color-text-muted)]">Partner orders never use a banker&apos;s account on this gateway.</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.exclusive} onChange={(e) => setF((p) => ({ ...p, exclusive: e.target.checked }))} />
            Exclusive: its bankers take partner orders only
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.auto_approve} onChange={(e) => setF((p) => ({ ...p, auto_approve: e.target.checked }))} />
            Approve its new sub-merchants automatically
          </label>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={m.isPending || !f.provider_id || !f.code.trim()}>{m.isPending ? "Saving…" : "Make partner"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function PartnersPage() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ["partners"], queryFn: async () => readJson<{ partners: PartnerListRow[]; can_create: boolean }>(await fetch("/api/partners")) });
  const columns: Column<PartnerListRow>[] = [
    { key: "code", header: "Code", render: (p) => <span className="font-mono font-medium">{p.code}</span> },
    { key: "name", header: "Name" },
    { key: "status", header: "Status", render: (p) => <Badge variant={p.status === "ACTIVE" ? "success" : "danger"}>{p.status === "ACTIVE" ? "Active" : "Suspended"}</Badge> },
    { key: "exclusive", header: "Bankers", render: (p) => p.exclusive ? "Exclusive" : "Shared" },
    { key: "subs_active", header: "Sub-merchants (active)", className: "text-right tabular-nums", render: (p) => `${p.subs_active} / ${p.subs_total}` },
    { key: "subs_pending", header: "Waiting review", className: "text-right tabular-nums",
      render: (p) => p.subs_pending > 0 ? <Badge variant="warning">{p.subs_pending}</Badge> : <span className="text-[color:var(--color-text-muted)]">0</span> },
    { key: "today_orders", header: "Live orders today", className: "text-right tabular-nums" },
    { key: "today_paid_amount", header: "Paid today", className: "text-right tabular-nums", render: (p) => rupees(p.today_paid_amount) },
  ];
  return (
    <div>
      <PageHeader title="Partners" icon={Handshake}
        description="Payment aggregators that onboard their own merchants on Katana. Their merchants' payments are taken by the partner's bankers and settled to the partner."
        actions={q.data?.can_create ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New partner</Button> : undefined} />
      <Card>
        <CardContent className="pt-6">
          {q.error ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p> : (
            <DataTable columns={columns} rows={q.data?.partners ?? []} loading={q.isLoading} rowKey={(p) => p.id}
              onRowClick={(p) => router.push(`/partners/${p.id}`)}
              emptyState={<>No partners yet. Make an existing merchant a partner with &quot;New partner&quot;.</>} />
          )}
        </CardContent>
      </Card>
      <NewPartnerDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
