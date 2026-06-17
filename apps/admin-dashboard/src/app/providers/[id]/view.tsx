"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, ChevronLeft, CheckCircle2, Circle, ShieldCheck, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Provider {
  id: string; code: string; legal_name: string; contact_email: string; contact_phone: string;
  kind: string; kyc_status: string; status: string; settlement_currency: string;
  bank_account_no: string; bank_ifsc: string; created_at: string;
}
interface User { id: string; email: string; name: string; role: string; created_at: string }
interface Doc { id: string; doc_type: string; uri: string; sha256: string; verified_at: string; verified_by: string; created_at: string }
interface Commission { id: string; rule_kind: string; rate_bps: number; fixed_fee: number; currency: string; valid_from: string; valid_to?: string }
interface Mapping { id: string; merchant_id: string; relation: string; created_at: string }

const REQUIRED_DOCS = ["PAN", "GST", "CIN", "MOA", "AOA", "BOARD_RESOLUTION", "ADDRESS_PROOF", "BANK_STATEMENT"] as const;

function KycActions({ provider }: { provider: Provider }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<"approve" | "reject" | "review" | null>(null);
  const [notes, setNotes] = useState("");

  const m = useMutation({
    mutationFn: async (kyc_status: "APPROVED" | "REJECTED" | "IN_REVIEW") => {
      const r = await fetch(`/api/providers/${provider.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kyc_status, notes }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: (_, kyc_status) => {
      toast.success(`KYC set to ${kyc_status}`);
      setOpen(null); setNotes("");
      qc.invalidateQueries({ queryKey: ["provider", provider.id] });
      qc.invalidateQueries({ queryKey: ["providers"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  if (provider.kyc_status === "APPROVED") return <Badge variant="success">KYC approved</Badge>;
  if (provider.kyc_status === "REJECTED") return <Badge variant="danger">KYC rejected</Badge>;

  return (
    <div className="flex gap-2">
      {provider.kyc_status !== "IN_REVIEW" && (
        <Button size="sm" variant="secondary" onClick={() => { setOpen("review"); m.mutate("IN_REVIEW"); }}>
          Mark in review
        </Button>
      )}
      <Dialog open={open === "approve"} onOpenChange={(o) => setOpen(o ? "approve" : null)}>
        <DialogTrigger asChild><Button size="sm"><ShieldCheck className="h-4 w-4" /> Approve KYC</Button></DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve provider KYC</DialogTitle>
            <DialogDescription>Marks {provider.code} as APPROVED. Provider can now go live.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>Notes (audit log)</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. 'all mandatory docs verified by ops'" />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(null)}>Cancel</Button>
            <Button onClick={() => m.mutate("APPROVED")} disabled={m.isPending}>{m.isPending ? "Approving…" : "Approve"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={open === "reject"} onOpenChange={(o) => setOpen(o ? "reject" : null)}>
        <DialogTrigger asChild><Button size="sm" variant="danger"><AlertTriangle className="h-4 w-4" /> Reject</Button></DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject provider KYC</DialogTitle>
            <DialogDescription>Marks {provider.code} as REJECTED. Provider cannot transact.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>Reason (required)</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. 'sanctions hit on UBO; insufficient docs'" />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => m.mutate("REJECTED")} disabled={m.isPending || !notes}>{m.isPending ? "Rejecting…" : "Reject"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusActions({ provider }: { provider: Provider }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async (status: "SUSPENDED" | "ACTIVE" | "TERMINATED") => {
      const r = await fetch(`/api/providers/${provider.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, notes: `status -> ${status}` }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: (_, status) => {
      toast.success(`Status -> ${status}`);
      qc.invalidateQueries({ queryKey: ["provider", provider.id] });
      qc.invalidateQueries({ queryKey: ["providers"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  if (provider.status === "TERMINATED") return <Badge variant="danger">Terminated</Badge>;
  return (
    <div className="flex gap-2">
      {provider.status === "ACTIVE"
        ? <Button size="sm" variant="secondary" onClick={() => m.mutate("SUSPENDED")} disabled={m.isPending}>Suspend</Button>
        : <Button size="sm" variant="secondary" onClick={() => m.mutate("ACTIVE")} disabled={m.isPending}>Re-activate</Button>}
      <Button size="sm" variant="danger" onClick={() => { if (confirm(`Terminate ${provider.code}? This cannot be undone.`)) m.mutate("TERMINATED"); }} disabled={m.isPending}>
        Terminate
      </Button>
    </div>
  );
}

export default function ProviderDetailView({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["provider", id],
    queryFn: async () => (await fetch(`/api/providers/${id}`).then((r) => r.json())) as {
      provider: Provider; users: User[]; docs: Doc[]; commission: Commission[]; mappings: Mapping[];
    },
  });

  if (q.isLoading) return <Card><CardContent className="py-8 text-center text-sm">Loading…</CardContent></Card>;
  if (!q.data?.provider) {
    return (
      <>
        <PageHeader title="Provider not found" icon={UserPlus} />
        <Card><CardContent className="py-8 text-center"><Link className="text-[color:var(--color-brand)] hover:underline" href="/providers">← back to providers</Link></CardContent></Card>
      </>
    );
  }

  const { provider, users, docs, commission, mappings } = q.data;

  const userCols: Column<User>[] = [
    { key: "email", header: "Email" },
    { key: "name", header: "Name", render: (r) => r.name || "—" },
    { key: "role", header: "Role", render: (r) => <Badge variant="brand">{r.role}</Badge> },
    { key: "created_at", header: "Added", render: (r) => formatDateTime(r.created_at) },
  ];
  const docCols: Column<Doc>[] = [
    { key: "doc_type", header: "Type" },
    { key: "sha256", header: "Hash", render: (r) => <span className="font-mono text-xs">{r.sha256.slice(0,12)}…</span> },
    { key: "verified_at", header: "Verified", render: (r) => r.verified_at ? <Badge variant="success">{formatDateTime(r.verified_at)}</Badge> : <Badge variant="warning">pending</Badge> },
    { key: "verified_by", header: "By", render: (r) => r.verified_by || "—" },
  ];
  const commCols: Column<Commission>[] = [
    { key: "rule_kind", header: "Kind" },
    { key: "rate_bps", header: "Rate (bps)" },
    { key: "fixed_fee", header: "Fixed", render: (r) => formatAmount(r.fixed_fee, r.currency) },
    { key: "valid_from", header: "From", render: (r) => formatDateTime(r.valid_from) },
    { key: "valid_to", header: "To", render: (r) => r.valid_to ? formatDateTime(r.valid_to) : "—" },
  ];
  const mapCols: Column<Mapping>[] = [
    { key: "merchant_id", header: "Merchant", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    { key: "relation", header: "Relation", render: (r) => <Badge variant="brand">{r.relation}</Badge> },
    { key: "created_at", header: "Mapped", render: (r) => formatDateTime(r.created_at) },
  ];

  const uploadedTypes = new Set(docs.map((d) => d.doc_type));
  const docChecklist = REQUIRED_DOCS.map((kind) => ({
    kind, uploaded: uploadedTypes.has(kind),
    verified: docs.some((d) => d.doc_type === kind && d.verified_at),
  }));
  const allDocsVerified = docChecklist.every((d) => d.verified);

  return (
    <>
      <PageHeader
        title={provider.legal_name}
        description={`${provider.code} · ${provider.kind} · ${provider.settlement_currency} · created ${formatDateTime(provider.created_at)}`}
        icon={UserPlus}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(provider.kyc_status)}>KYC {provider.kyc_status}</Badge>
            <Badge variant={statusVariant(provider.status)}>{provider.status}</Badge>
            <Link href="/providers" className="text-xs text-[color:var(--color-text-muted)] hover:text-[color:var(--color-brand)] inline-flex items-center"><ChevronLeft className="h-3 w-3" /> back</Link>
          </div>
        }
      />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Provider KYC stepper</CardTitle>
          <CardDescription>Per PRODUCT_VISION §2.1 — mandatory docs + approval before live.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {docChecklist.map((d) => (
              <li key={d.kind} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                {d.verified ? <CheckCircle2 className="h-4 w-4 text-[color:var(--color-success)]" /> : <Circle className="h-4 w-4 text-[color:var(--color-text-subtle)]" />}
                <span className="font-medium flex-1">{d.kind}</span>
                {d.verified ? <Badge variant="success">verified</Badge> : d.uploaded ? <Badge variant="warning">pending</Badge> : <Badge variant="default">missing</Badge>}
              </li>
            ))}
          </ol>
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-xs text-[color:var(--color-text-muted)]">
              {allDocsVerified ? "All mandatory docs verified — eligible for KYC approval." : `${docChecklist.filter((d) => d.verified).length}/${REQUIRED_DOCS.length} verified.`}
            </span>
            <KycActions provider={provider} />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 mb-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Identity & bank</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div><span className="text-[color:var(--color-text-muted)]">Code:</span> <span className="font-mono">{provider.code}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">Legal name:</span> {provider.legal_name}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Kind:</span> {provider.kind}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Email:</span> {provider.contact_email}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Phone:</span> {provider.contact_phone || "—"}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Bank account:</span> <span className="font-mono">{provider.bank_account_no || "—"}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">IFSC:</span> {provider.bank_ifsc || "—"}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Status actions</CardTitle><CardDescription>Suspend / re-activate / terminate.</CardDescription></CardHeader>
          <CardContent><StatusActions provider={provider} /></CardContent>
        </Card>
      </div>

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Provider users ({users.length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={userCols} rows={users} rowKey={(r) => r.id} emptyState="No provider users yet." /></CardContent>
      </Card>
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">KYC documents ({docs.length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={docCols} rows={docs} rowKey={(r) => r.id} emptyState="No documents uploaded." /></CardContent>
      </Card>
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Commission rules ({commission.length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={commCols} rows={commission} rowKey={(r) => r.id} emptyState="No commission rules." /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Mapped merchants ({mappings.length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={mapCols} rows={mappings} rowKey={(r) => r.id} emptyState="No merchants mapped." /></CardContent>
      </Card>
    </>
  );
}
