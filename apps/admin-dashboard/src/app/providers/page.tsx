"use client";

// L1 — world-class providers list. Composes DataView (search/filter/density/
// columns/saved-views/bulk/FAB) + RowActions (kebab) + EmptyState.

import Link from "next/link";
import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { UserPlus, Plus, Pencil, Archive, Trash2 } from "lucide-react";
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
import { RowActions, ACT } from "@/components/world-class/row-actions";
import { useCan } from "@/lib/use-access";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Provider {
  id: string; code: string; legal_name: string; contact_email: string;
  kind: string; kyc_status: string; status: string; settlement_currency: string;
  user_count: number; doc_count: number; merchant_count: number; created_at: string;
}

function CreateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    code: "PRV-XXX", legal_name: "New Partner Pvt Ltd",
    contact_email: "ops@partner.example", contact_phone: "9999988888",
    kind: "PROVIDER",
  });
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/providers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Provider created"); qc.invalidateQueries({ queryKey: ["providers"] }); onOpenChange(false); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Create provider</DialogTitle>
          <DialogDescription>Kind: PROVIDER, AGENT, PARTNER, FRANCHISE.</DialogDescription></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {(["code","legal_name","contact_email","contact_phone","kind"] as const).map((k) => (
            <div key={k} className={k === "legal_name" ? "space-y-1.5 col-span-2" : "space-y-1.5"}>
              <Label>{k.replace(/_/g," ")}</Label>
              <Input value={(form as Record<string, string>)[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Creating…" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ProvidersPage() {
  const qc = useQueryClient();
  const canCreate = useCan("providers", "create");
  const canUpdate = useCan("providers", "update");
  const canDelete = useCan("providers", "delete");
  const [createOpen, setCreateOpen] = useState(false);
  const sp = useSearchParams();

  // Cmd+K "New provider" deep-link.
  useEffect(() => { if (sp.get("new") === "1" && canCreate) setCreateOpen(true); }, [sp, canCreate]);

  const q = useQuery({
    queryKey: ["providers"],
    queryFn: async () => (await fetch("/api/providers").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { providers: Provider[] },
  });

  const patch = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) => {
      const r = await fetch(`/api/providers/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["providers"] }),
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const cols: Column<Provider>[] = [
    { key: "code", header: "Code",
      render: (r) => <Link className="text-[color:var(--color-brand)] hover:underline font-medium" href={`/providers/${r.id}`}>{r.code}</Link> },
    { key: "legal_name", header: "Legal name",
      render: (r) => <Link className="hover:underline" href={`/providers/${r.id}`}>{r.legal_name}</Link> },
    { key: "kind", header: "Kind" },
    { key: "kyc_status", header: "KYC", render: (r) => <Badge variant={statusVariant(r.kyc_status)}>{r.kyc_status}</Badge> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "merchant_count", header: "Branches" },
    { key: "contact_email", header: "Contact" },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  const rows = q.data?.providers ?? [];

  return (
    <>
      <PageHeader
        title="Providers"
        description="Sub-admin reseller entities and their KYC lifecycle (PRODUCT_VISION §3.1)."
        icon={UserPlus}
      />
      <DataView
        rows={rows}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search by code, name, contact…", fields: ["code", "legal_name", "contact_email"] }}
        filters={[
          { key: "kyc:pending",  label: "KYC pending",   predicate: (r) => r.kyc_status === "PENDING" || r.kyc_status === "IN_REVIEW" },
          { key: "kyc:approved", label: "KYC approved",  predicate: (r) => r.kyc_status === "APPROVED" },
          { key: "kyc:rejected", label: "KYC rejected",  predicate: (r) => r.kyc_status === "REJECTED" },
          { key: "active",       label: "Active",        predicate: (r) => r.status === "ACTIVE" },
          { key: "suspended",    label: "Suspended",     predicate: (r) => r.status === "SUSPENDED" },
        ]}
        href={(r) => `/providers/${r.id}`}
        fab={canCreate ? { label: "Provider", icon: Plus, onClick: () => setCreateOpen(true) } : undefined}
        refresh={() => q.refetch()}
        savedViewKey="providers"
        emptyTitle="No providers yet"
        emptyDescription="Onboard your first reseller to start the KYC lifecycle."
        bulkActions={canUpdate || canDelete ? [
          ...(canUpdate ? [{ label: "Suspend", icon: Archive, variant: "secondary" as const,
            onClick: () => toast.info("Bulk suspend coming next — wire to PATCH /api/providers/:id") }] : []),
          ...(canDelete ? [{ label: "Delete",  icon: Trash2,  variant: "danger" as const,
            onClick: () => toast.info("Bulk delete coming next — wire to DELETE /api/providers/:id") }] : []),
        ] : []}
        rowActions={(r) => (
          <RowActions
            openHref={`/providers/${r.id}`}
            actions={[
              ...(canUpdate ? [ACT.edit(() => (window.location.href = `/providers/${r.id}?tab=settings`))] : []),
              ...(canUpdate && r.status === "ACTIVE"
                ? [{ label: "Suspend", icon: Archive, onClick: () => patch.mutate({ id: r.id, body: { status: "SUSPENDED" } }) }]
                : canUpdate && r.status === "SUSPENDED"
                ? [{ label: "Reactivate", icon: Pencil, onClick: () => patch.mutate({ id: r.id, body: { status: "ACTIVE" } }) }]
                : []),
              ...(canDelete ? [ACT.remove(() => {
                if (confirm(`Terminate ${r.code}? This is reversible via reactivate.`))
                  patch.mutate({ id: r.id, body: { status: "TERMINATED" } });
              })] : []),
            ]}
          />
        )}
      />
      <CreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
