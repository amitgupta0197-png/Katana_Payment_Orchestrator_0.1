"use client";

// L1 — tenants. DataView with type filter chips + search.

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Globe, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { DataView } from "@/components/world-class/data-view";
import { useCan } from "@/lib/use-access";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Tenant { id: string; parent_id: string; type: string; code: string; name: string; status: string; created_at: string }

function CreateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    code: "tenant-new", name: "New Tenant",
    type: "MERCHANT" as "PLATFORM" | "PROVIDER" | "MERCHANT",
    parent_id: "00000000-0000-0000-0000-000000000001",
  });
  const m = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = { code: form.code, name: form.name, type: form.type };
      if (form.parent_id) payload.parent_id = form.parent_id;
      const r = await fetch("/api/tenants", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Tenant created"); qc.invalidateQueries({ queryKey: ["tenants"] }); onOpenChange(false); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create tenant</DialogTitle>
          <DialogDescription>PLATFORM is the root; PROVIDER/MERCHANT branch off a parent tenant.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label>Code</Label><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
          <div className="space-y-1.5"><Label>Type</Label>
            <select className="h-10 w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 text-sm"
              value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as typeof form.type })}>
              <option value="PLATFORM">PLATFORM</option><option value="PROVIDER">PROVIDER</option><option value="MERCHANT">MERCHANT</option>
            </select>
          </div>
          <div className="space-y-1.5 col-span-2"><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="space-y-1.5 col-span-2">
            <Label>Parent tenant ID {form.type === "PLATFORM" && <span className="text-xs text-[color:var(--color-text-muted)]">(blank for root)</span>}</Label>
            <Input value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })} placeholder="uuid" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Creating…" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TenantsPage() {
  const canCreate = useCan("tenants", "create");
  const sp = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  useEffect(() => { if (sp.get("new") === "1" && canCreate) setCreateOpen(true); }, [sp, canCreate]);

  const q = useQuery({
    queryKey: ["tenants"],
    queryFn: async () => (await fetch("/api/tenants").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { tenants: Tenant[] },
  });
  const rows = q.data?.tenants ?? [];

  const cols: Column<Tenant>[] = [
    { key: "code", header: "Code", render: (r) => <span className="font-mono text-xs">{r.code}</span> },
    { key: "name", header: "Name" },
    { key: "type", header: "Type", render: (r) => <Badge variant="brand">{r.type}</Badge> },
    { key: "parent_id", header: "Parent", render: (r) => r.parent_id ? <span className="font-mono text-xs">{r.parent_id.slice(0, 8)}…</span> : "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="Tenants" description="Multi-tenant management (PRODUCT_VISION §3.11)." icon={Globe} />
      <DataView rows={rows} columns={cols} rowKey={(r) => r.id} loading={q.isLoading}
        search={{ placeholder: "Search by code / name…", fields: ["code", "name"] }}
        filters={[
          { key: "platform", label: "PLATFORM", predicate: (r: Tenant) => r.type === "PLATFORM" },
          { key: "provider", label: "PROVIDER", predicate: (r: Tenant) => r.type === "PROVIDER" },
          { key: "merchant", label: "MERCHANT", predicate: (r: Tenant) => r.type === "MERCHANT" },
          { key: "active",   label: "Active",   predicate: (r: Tenant) => r.status === "ACTIVE" },
        ]}
        fab={canCreate ? { label: "Tenant", icon: Plus, onClick: () => setCreateOpen(true) } : undefined}
        refresh={() => q.refetch()}
        savedViewKey="tenants"
        emptyTitle="No tenants yet" emptyDescription="Create the first tenant — PLATFORM is the root, PROVIDER/MERCHANT branch off it." />
      <CreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
