"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { useCan } from "@/lib/use-access";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Tenant { id: string; parent_id: string; type: string; code: string; name: string; status: string; created_at: string }

function CreateDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    code: "tenant-new",
    name: "New Tenant",
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
    onSuccess: () => { toast.success("Tenant created"); qc.invalidateQueries({ queryKey: ["tenants"] }); setOpen(false); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus /> Tenant</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create tenant</DialogTitle>
          <DialogDescription>PLATFORM is the root; PROVIDER/MERCHANT branch off a parent tenant.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Code</Label>
            <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <select
              className="h-10 w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 text-sm"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value as typeof form.type })}
            >
              <option value="PLATFORM">PLATFORM</option>
              <option value="PROVIDER">PROVIDER</option>
              <option value="MERCHANT">MERCHANT</option>
            </select>
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>Parent tenant ID {form.type === "PLATFORM" && <span className="text-xs text-[color:var(--color-text-muted)]">(leave blank for root)</span>}</Label>
            <Input
              value={form.parent_id}
              onChange={(e) => setForm({ ...form, parent_id: e.target.value })}
              placeholder="uuid"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Creating…" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TenantsPage() {
  const canCreate = useCan("tenants", "create");
  const q = useQuery({
    queryKey: ["tenants"],
    queryFn: async () => (await fetch("/api/tenants").then((r) => r.json())) as { tenants: Tenant[] },
  });
  const cols: Column<Tenant>[] = [
    { key: "code", header: "Code" },
    { key: "name", header: "Name" },
    { key: "type", header: "Type" },
    { key: "parent_id", header: "Parent", render: (r) => r.parent_id ? <span className="font-mono text-xs">{r.parent_id.slice(0,8)}…</span> : "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];
  return (
    <>
      <PageHeader
        title="Tenants"
        description="Multi-tenant management (PRODUCT_VISION §3.11)."
        icon={Globe}
        actions={canCreate ? <CreateDialog /> : null}
      />
      <Card><CardHeader><CardTitle>{(q.data?.tenants ?? []).length} tenants</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.tenants ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No tenants." /></CardContent>
      </Card>
    </>
  );
}
