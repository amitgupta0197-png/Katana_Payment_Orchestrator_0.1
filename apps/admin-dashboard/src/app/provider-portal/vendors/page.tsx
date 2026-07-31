"use client";

// UPLINE vendor registry (BRD §3): the vendors/beneficiaries this provider settles to —
// bank + compliance detail (PAN/GST), category, supporting documents, and a lifecycle
// status (Active / Blocked / Under review). Only ACTIVE vendors can receive settlements.
// Branches never see this list — they only get the snapshot on a settlement.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Contact, Plus, Activity, ShieldBan, ShieldCheck, ShieldQuestion, FileUp } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RowActions } from "@/components/world-class/row-actions";
import { formatDateTime } from "@/lib/utils";

interface Vendor {
  id: string; vendor_name: string; beneficiary_name: string; account_number?: string | null;
  ifsc?: string | null; bank_name?: string | null; bank_branch?: string | null; account_type?: string | null;
  vpa?: string | null; mobile_number?: string | null; pan?: string | null; gstin?: string | null;
  settlement_ref?: string | null; category?: string | null; status: "ACTIVE" | "BLOCKED" | "UNDER_REVIEW";
  notes?: string | null; doc_count: number; created_at: string;
}

const statusVariant = (s: string) => s === "ACTIVE" ? "success" : s === "BLOCKED" ? "danger" : "warning";
const statusLabel = (s: string) => s === "UNDER_REVIEW" ? "Under review" : s === "ACTIVE" ? "Active" : "Blocked";

export default function VendorsPage() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: async () => (await fetch("/api/auth/me").then((r) => r.json())) as { scope: { id: string } } });
  const providerId = me.data?.scope?.id;

  const vendors = useQuery({
    queryKey: ["vendors", providerId],
    enabled: !!providerId,
    queryFn: async () => (await fetch(`/api/providers/${providerId}/vendors`).then((r) => r.json())) as { vendors: Vendor[] },
    refetchInterval: 30_000,
  });
  const [addOpen, setAddOpen] = useState(false);
  const [docsFor, setDocsFor] = useState<Vendor | null>(null);

  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const r = await fetch(`/api/providers/${providerId}/vendors/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
      });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "Failed"); return d;
    },
    onSuccess: () => { toast.success("Vendor updated"); qc.invalidateQueries({ queryKey: ["vendors"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const list = vendors.data?.vendors ?? [];
  const cols: Column<Vendor>[] = [
    { key: "vendor_name", header: "Vendor", render: (r) => (
      <div><span className="font-medium">{r.vendor_name}</span>
        {r.category ? <Badge variant="info">{r.category}</Badge> : null}
        <div className="text-xs text-[color:var(--color-text-muted)]">{r.beneficiary_name}</div></div>
    ) },
    { key: "bank", header: "Pay to", render: (r) => (
      <span className="text-xs font-mono">{r.vpa || `${r.account_number ?? "—"}${r.ifsc ? ` · ${r.ifsc}` : ""}`}
        {r.bank_name ? <span className="block text-[color:var(--color-text-muted)]">{r.bank_name}{r.account_type ? ` · ${r.account_type}` : ""}</span> : null}</span>
    ) },
    { key: "tax", header: "PAN / GST", render: (r) => <span className="text-xs font-mono">{r.pan ?? "—"}{r.gstin ? ` / ${r.gstin}` : ""}</span> },
    { key: "docs", header: "Docs", render: (r) => <Badge variant={r.doc_count > 0 ? "brand" : "default"}>{r.doc_count}</Badge> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status) as never}>{statusLabel(r.status)}</Badge> },
    { key: "created_at", header: "Added", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
    { key: "actions", header: "", render: (r) => (
      <RowActions actions={[
        { label: "Upload document", icon: FileUp, onClick: () => setDocsFor(r) },
        ...(r.status !== "ACTIVE" ? [{ label: "Activate", icon: ShieldCheck, onClick: () => setStatus.mutate({ id: r.id, status: "ACTIVE" }) }] : []),
        ...(r.status !== "UNDER_REVIEW" ? [{ label: "Put under review", icon: ShieldQuestion, onClick: () => setStatus.mutate({ id: r.id, status: "UNDER_REVIEW" }) }] : []),
        ...(r.status !== "BLOCKED" ? [{ label: "Block", icon: ShieldBan, variant: "danger" as const, onClick: () => setStatus.mutate({ id: r.id, status: "BLOCKED" }) }] : []),
      ]} />
    ) },
  ];

  return (
    <>
      <PageHeader
        title="Vendors"
        description="The vendors your settlements pay out to. Only Active vendors can receive a settlement; blocking never deletes history."
        icon={Contact}
        actions={<div className="flex items-center gap-2">
          <Badge variant={vendors.isFetching ? "info" : "default"}><Activity className="h-3 w-3 mr-1" />live</Badge>
          <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add vendor</Button>
        </div>}
      />

      <div className="mb-6 grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Active</div><div className="text-2xl font-semibold tabular-nums">{list.filter((v) => v.status === "ACTIVE").length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Under review</div><div className="text-2xl font-semibold tabular-nums">{list.filter((v) => v.status === "UNDER_REVIEW").length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Blocked</div><div className="text-2xl font-semibold tabular-nums">{list.filter((v) => v.status === "BLOCKED").length}</div></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Vendor registry</CardTitle><CardDescription>Visible only to you and Katana — a branch sees a vendor's payout details only on a settlement addressed to it.</CardDescription></CardHeader>
        <CardContent>
          <DataTable columns={cols} rows={list} rowKey={(r) => r.id} loading={vendors.isLoading} emptyState="No vendors yet — add the people and businesses your settlements pay." />
        </CardContent>
      </Card>

      {providerId && <AddVendorDialog open={addOpen} onOpenChange={setAddOpen} providerId={providerId}
        onDone={() => { setAddOpen(false); qc.invalidateQueries({ queryKey: ["vendors"] }); }} />}
      {providerId && <VendorDocsDialog vendor={docsFor} providerId={providerId} onClose={() => setDocsFor(null)}
        onDone={() => qc.invalidateQueries({ queryKey: ["vendors"] })} />}
    </>
  );
}

function AddVendorDialog({ open, onOpenChange, providerId, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; providerId: string; onDone: () => void;
}) {
  const empty = { vendor_name: "", beneficiary_name: "", account_number: "", ifsc: "", bank_name: "", bank_branch: "", account_type: "", vpa: "", mobile_number: "", pan: "", gstin: "", settlement_ref: "", category: "", notes: "" };
  const [f, setF] = useState(empty);
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const add = useMutation({
    mutationFn: async () => {
      const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ""));
      const r = await fetch(`/api/providers/${providerId}/vendors`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "Failed"); return d;
    },
    onSuccess: () => { toast.success("Vendor added"); setF(empty); onDone(); },
    onError: (e: Error) => toast.error("Couldn’t add vendor", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Add vendor</DialogTitle><DialogDescription>Bank account (or UPI VPA) plus compliance details. You can upload documents after saving.</DialogDescription></DialogHeader>
        <div className="grid max-h-[55vh] grid-cols-2 gap-3 overflow-auto pr-1">
          <div><Label className="text-xs">Vendor name *</Label><Input value={f.vendor_name} onChange={(e) => set("vendor_name", e.target.value)} /></div>
          <div><Label className="text-xs">Beneficiary name *</Label><Input value={f.beneficiary_name} onChange={(e) => set("beneficiary_name", e.target.value)} /></div>
          <div><Label className="text-xs">Account number</Label><Input value={f.account_number} onChange={(e) => set("account_number", e.target.value)} /></div>
          <div><Label className="text-xs">IFSC</Label><Input value={f.ifsc} onChange={(e) => set("ifsc", e.target.value)} /></div>
          <div><Label className="text-xs">Bank name</Label><Input value={f.bank_name} onChange={(e) => set("bank_name", e.target.value)} /></div>
          <div><Label className="text-xs">Branch</Label><Input value={f.bank_branch} onChange={(e) => set("bank_branch", e.target.value)} /></div>
          <div><Label className="text-xs">Account type</Label>
            <select value={f.account_type} onChange={(e) => set("account_type", e.target.value)} className="w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm">
              <option value="">—</option><option>SAVINGS</option><option>CURRENT</option>
            </select></div>
          <div><Label className="text-xs">UPI VPA (alternative)</Label><Input value={f.vpa} onChange={(e) => set("vpa", e.target.value)} placeholder="name@bank" /></div>
          <div><Label className="text-xs">Mobile</Label><Input value={f.mobile_number} onChange={(e) => set("mobile_number", e.target.value)} /></div>
          <div><Label className="text-xs">Category</Label><Input value={f.category} onChange={(e) => set("category", e.target.value)} placeholder="SUPPLIER / LOGISTICS / …" /></div>
          <div><Label className="text-xs">PAN</Label><Input value={f.pan} onChange={(e) => set("pan", e.target.value)} /></div>
          <div><Label className="text-xs">GSTIN</Label><Input value={f.gstin} onChange={(e) => set("gstin", e.target.value)} /></div>
          <div><Label className="text-xs">Your settlement reference</Label><Input value={f.settlement_ref} onChange={(e) => set("settlement_ref", e.target.value)} /></div>
          <div><Label className="text-xs">Notes</Label><Input value={f.notes} onChange={(e) => set("notes", e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => add.mutate()} disabled={add.isPending || f.vendor_name.length < 2 || f.beneficiary_name.length < 2 || (!f.vpa && !(f.account_number && f.ifsc))}>Save vendor</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VendorDocsDialog({ vendor, providerId, onClose, onDone }: {
  vendor: Vendor | null; providerId: string; onClose: () => void; onDone: () => void;
}) {
  const [docType, setDocType] = useState("CANCELLED_CHEQUE");
  const [busy, setBusy] = useState(false);
  const docs = useQuery({
    queryKey: ["vendor-docs", vendor?.id],
    enabled: !!vendor,
    queryFn: async () => (await fetch(`/api/providers/${providerId}/vendors/${vendor!.id}/docs`).then((r) => r.json())) as {
      documents: Array<{ id: string; doc_type: string; created_at: string; uploaded_by: string | null }>; doc_types: string[];
    },
  });
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("doc_type", docType); fd.append("file", file);
      const r = await fetch(`/api/providers/${providerId}/vendors/${vendor!.id}/docs`, { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      toast.success("Document uploaded"); docs.refetch(); onDone();
    } catch (e) { toast.error("Upload failed", { description: (e as Error).message }); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={!!vendor} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Documents — {vendor?.vendor_name}</DialogTitle><DialogDescription>Cancelled cheque, GST certificate, agreements… (PNG/JPEG/WEBP/PDF)</DialogDescription></DialogHeader>
        <div className="space-y-2 max-h-40 overflow-auto">
          {(docs.data?.documents ?? []).length === 0
            ? <p className="text-sm text-[color:var(--color-text-muted)]">No documents yet.</p>
            : (docs.data?.documents ?? []).map((d) => (
              <div key={d.id} className="flex items-center justify-between rounded-md border p-2 text-xs">
                <Badge variant="info">{d.doc_type}</Badge>
                <span className="text-[color:var(--color-text-muted)]">{d.uploaded_by ?? "—"} · {formatDateTime(d.created_at)}</span>
              </div>
            ))}
        </div>
        <div className="flex items-end gap-2 border-t pt-3">
          <div className="flex-1"><Label className="text-xs">Document type</Label>
            <select value={docType} onChange={(e) => setDocType(e.target.value)} className="w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm">
              {(docs.data?.doc_types ?? ["CANCELLED_CHEQUE", "GST_CERT", "PAN_CARD", "AGREEMENT", "INVOICE", "OTHER"]).map((t) => <option key={t}>{t}</option>)}
            </select></div>
          <label className="cursor-pointer">
            <input type="file" className="hidden" accept="image/png,image/jpeg,image/webp,application/pdf"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.currentTarget.value = ""; }} />
            <span className="inline-flex h-9 items-center rounded-md bg-[color:var(--color-brand,#35E9D8)] px-3 text-sm font-medium text-black">
              {busy ? "Uploading…" : "Choose file"}
            </span>
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
