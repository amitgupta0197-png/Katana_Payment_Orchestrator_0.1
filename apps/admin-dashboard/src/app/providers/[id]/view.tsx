"use client";

// L3 — world-class provider detail. Composes DetailShell (tabs + sticky
// action rail) + ActivityFeed + Drawer (for L4 merchant sub-detail).
//
// Tabs: Overview · KYC docs · Users · Commission · Merchants · Activity ·
//       Settings · Danger zone
// Primary CTAs route through the existing /api/providers/[id] PATCH; the
// status & KYC mutations write WORM audit rows via the API helper.

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  UserPlus, ShieldCheck, AlertTriangle, FileCheck2, Users, Activity, Settings,
  AlertOctagon, Receipt, Network, Plus, CheckCircle2, Circle, Pause, Play, XOctagon, ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DetailShell } from "@/components/world-class/detail-shell";
import { ActivityFeed } from "@/components/world-class/activity-feed";
import { InlineEdit } from "@/components/world-class/inline-edit";
import { RowActions, ACT } from "@/components/world-class/row-actions";
import { EmptyState } from "@/components/world-class/empty-state";
import { useCan } from "@/lib/use-access";
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

function KycDecisionDialog({
  provider, decision, open, onOpenChange, trigger,
}: {
  provider: Provider;
  decision: "APPROVED" | "REJECTED" | "IN_REVIEW";
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  trigger?: React.ReactNode;
}) {
  const qc = useQueryClient();
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined;
  const actualOpen = isControlled ? open : internalOpen;
  const setOpen = isControlled ? (o: boolean) => onOpenChange?.(o) : setInternalOpen;
  const [notes, setNotes] = useState("");
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/providers/${provider.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kyc_status: decision, notes }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success(`KYC ${decision}`);
      setOpen(false); setNotes("");
      qc.invalidateQueries({ queryKey: ["provider", provider.id] });
      qc.invalidateQueries({ queryKey: ["activity", "provider", provider.id] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const isApprove = decision === "APPROVED";
  const isReject = decision === "REJECTED";
  return (
    <Dialog open={actualOpen} onOpenChange={setOpen}>
      {trigger ?? (
        <DialogTrigger asChild>
          <Button size="sm" variant={isApprove ? "default" : isReject ? "danger" : "secondary"}>
            {isApprove ? <ShieldCheck className="h-4 w-4" /> : isReject ? <AlertTriangle className="h-4 w-4" /> : <FileCheck2 className="h-4 w-4" />}
            {isApprove ? "Approve KYC" : isReject ? "Reject KYC" : "Mark in review"}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isApprove ? "Approve" : isReject ? "Reject" : "Mark in review"} — {provider.code}</DialogTitle>
          <DialogDescription>
            {isApprove ? "Provider will be eligible to go live." : isReject ? "Provider cannot transact until re-submitted." : "Provider stays in IN_REVIEW state."}
            {" "}Notes are written to the WORM audit log.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Notes {isReject ? "(required)" : "(optional)"}</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={isReject ? "e.g. sanctions hit; insufficient docs" : "audit context"} />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant={isApprove ? "default" : isReject ? "danger" : "secondary"}
            onClick={() => m.mutate()}
            disabled={m.isPending || (isReject && !notes)}
          >
            {m.isPending ? "Working…" : `Confirm ${decision.toLowerCase()}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ProviderDetailView({ id }: { id: string }) {
  const qc = useQueryClient();
  const canUpdate = useCan("providers", "update");
  const canAdmin = useCan("providers", "admin");
  const canDelete = useCan("providers", "delete");
  const canMerchantCreate = useCan("merchants", "create");
  const [merchantDrawer, setMerchantDrawer] = useState<Mapping | null>(null);
  const [kycDialog, setKycDialog] = useState<"APPROVED" | "REJECTED" | "IN_REVIEW" | null>(null);

  const q = useQuery({
    queryKey: ["provider", id],
    queryFn: async () => (await fetch(`/api/providers/${id}`).then((r) => r.json())) as {
      provider: Provider; users: User[]; docs: Doc[]; commission: Commission[]; mappings: Mapping[];
    },
  });

  const statusMut = useMutation({
    mutationFn: async (status: "SUSPENDED" | "ACTIVE" | "TERMINATED") => {
      const r = await fetch(`/api/providers/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, notes: `status -> ${status}` }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: (_, status) => {
      toast.success(`Status → ${status}`);
      qc.invalidateQueries({ queryKey: ["provider", id] });
      qc.invalidateQueries({ queryKey: ["providers"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const inlineSave = (field: string) => async (next: string) => {
    const r = await fetch(`/api/providers/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: next, notes: `inline edit: ${field}` }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
    toast.success(`${field} updated`);
    qc.invalidateQueries({ queryKey: ["provider", id] });
  };

  if (q.isLoading) return <Card><CardContent className="py-8 text-center text-sm">Loading…</CardContent></Card>;
  if (!q.data?.provider) {
    return (
      <EmptyState
        icon={UserPlus}
        title="Provider not found"
        description="It may have been terminated or you don't have access."
        secondaryAction={{ label: "Back to providers", href: "/providers" }}
      />
    );
  }

  const { provider, users, docs, commission, mappings } = q.data;
  const uploadedTypes = new Set(docs.map((d) => d.doc_type));
  const docChecklist = REQUIRED_DOCS.map((kind) => ({
    kind, uploaded: uploadedTypes.has(kind),
    verified: docs.some((d) => d.doc_type === kind && d.verified_at),
  }));
  const verifiedCount = docChecklist.filter((d) => d.verified).length;
  const allDocsVerified = verifiedCount === REQUIRED_DOCS.length;
  const kycPending = provider.kyc_status === "PENDING" || provider.kyc_status === "IN_REVIEW";

  // ---- Columns ----
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
    { key: "merchant_id", header: "Merchant", render: (r) => <button onClick={() => setMerchantDrawer(r)} className="font-mono text-xs text-[color:var(--color-brand)] hover:underline">{r.merchant_id}</button> },
    { key: "relation", header: "Relation", render: (r) => <Badge variant="brand">{r.relation}</Badge> },
    { key: "created_at", header: "Mapped", render: (r) => formatDateTime(r.created_at) },
    { key: "actions", header: "", render: (r) => (
      <RowActions
        actions={[
          { label: "Open in drawer", icon: ExternalLink, onClick: () => setMerchantDrawer(r) },
          { label: "Open merchant page", icon: ExternalLink, onClick: () => window.open(`/merchants?q=${r.merchant_id}`, "_blank") },
        ]}
      />
    )},
  ];

  // ---- Tabs ----
  const tabs = [
    { key: "overview", label: "Overview", icon: UserPlus, content: (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Identity & bank</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[color:var(--color-text-muted)]">Code</span>
              <span className="font-mono">{provider.code}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[color:var(--color-text-muted)]">Legal name</span>
              <InlineEdit value={provider.legal_name} readOnly={!canUpdate} onSave={inlineSave("legal_name")} label="legal name" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[color:var(--color-text-muted)]">Kind</span>
              <span>{provider.kind}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[color:var(--color-text-muted)]">Email</span>
              <InlineEdit value={provider.contact_email} readOnly={!canUpdate} onSave={inlineSave("contact_email")} label="contact email" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[color:var(--color-text-muted)]">Phone</span>
              <InlineEdit value={provider.contact_phone || ""} placeholder="—" readOnly={!canUpdate} onSave={inlineSave("contact_phone")} label="contact phone" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[color:var(--color-text-muted)]">Bank account</span>
              <span className="font-mono">{provider.bank_account_no || "—"}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[color:var(--color-text-muted)]">IFSC</span>
              <span>{provider.bank_ifsc || "—"}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">KYC checklist</CardTitle>
            <CardDescription>{verifiedCount}/{REQUIRED_DOCS.length} mandatory docs verified.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
              {docChecklist.map((d) => (
                <li key={d.kind} className="flex items-center gap-2 rounded-md border p-1.5">
                  {d.verified
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-[color:var(--color-success)]" />
                    : <Circle className="h-3.5 w-3.5 text-[color:var(--color-text-subtle)]" />}
                  <span className="font-medium flex-1 truncate text-xs">{d.kind}</span>
                  {d.verified
                    ? <Badge variant="success">ok</Badge>
                    : d.uploaded
                      ? <Badge variant="warning">pending</Badge>
                      : <Badge variant="default">missing</Badge>}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    )},
    { key: "docs", label: "KYC docs", icon: FileCheck2, count: docs.length, content: (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div><CardTitle className="text-base">Documents ({docs.length})</CardTitle></div>
          {canUpdate && (
            <Button size="sm" onClick={() => toast.info("Doc upload UI lands in WC-6 propagate")}><Plus className="h-4 w-4" /> Upload</Button>
          )}
        </CardHeader>
        <CardContent>
          {docs.length === 0
            ? <EmptyState icon={FileCheck2} title="No documents uploaded" description="Upload PAN/GST/MOA/AOA/Board Resolution to start the KYC workflow." />
            : <DataTable columns={docCols} rows={docs} rowKey={(r) => r.id} />}
        </CardContent>
      </Card>
    )},
    { key: "users", label: "Users", icon: Users, count: users.length, content: (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Provider users ({users.length})</CardTitle>
          {canUpdate && (
            <Button size="sm" onClick={() => toast.info("Add provider-user lands in WC-6 propagate")}><Plus className="h-4 w-4" /> Add user</Button>
          )}
        </CardHeader>
        <CardContent>
          {users.length === 0
            ? <EmptyState icon={Users} title="No provider users" description="Invite ops users so the provider team can self-manage." />
            : <DataTable columns={userCols} rows={users} rowKey={(r) => r.id} />}
        </CardContent>
      </Card>
    )},
    { key: "commission", label: "Commission", icon: Receipt, count: commission.length, content: (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Commission rules ({commission.length})</CardTitle>
          {canAdmin && (
            <Button size="sm" onClick={() => toast.info("Commission rule editor lands in WC-6 propagate")}><Plus className="h-4 w-4" /> New rule</Button>
          )}
        </CardHeader>
        <CardContent>
          {commission.length === 0
            ? <EmptyState icon={Receipt} title="No commission rules" description="Add a rule (bps + fixed fee) to start accruing commission." />
            : <DataTable columns={commCols} rows={commission} rowKey={(r) => r.id} />}
        </CardContent>
      </Card>
    )},
    { key: "merchants", label: "Merchants", icon: Network, count: mappings.length, content: (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Mapped merchants ({mappings.length})</CardTitle>
          {canMerchantCreate && (
            <Button size="sm" onClick={() => window.open("/merchants?new=1", "_blank")}><Plus className="h-4 w-4" /> Onboard merchant</Button>
          )}
        </CardHeader>
        <CardContent>
          {mappings.length === 0
            ? <EmptyState icon={Network} title="No merchants mapped" description="Onboard merchants under this provider to start volume." action={canMerchantCreate ? { label: "Onboard merchant", icon: Plus, onClick: () => window.open("/merchants?new=1", "_blank") } : undefined} />
            : <DataTable columns={mapCols} rows={mappings} rowKey={(r) => r.id} onRowClick={(r) => setMerchantDrawer(r)} />}
        </CardContent>
      </Card>
    )},
    { key: "activity", label: "Activity", icon: Activity, content: (
      <ActivityFeed resourceType="provider" resourceId={id} />
    )},
    { key: "settings", label: "Settings", icon: Settings, hidden: !canUpdate, content: (
      <Card>
        <CardHeader><CardTitle className="text-base">Editable fields</CardTitle>
          <CardDescription>Inline-edits flow through the WORM audit log.</CardDescription></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <Label className="w-40">Legal name</Label>
            <InlineEdit value={provider.legal_name} onSave={inlineSave("legal_name")} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label className="w-40">Contact email</Label>
            <InlineEdit value={provider.contact_email} onSave={inlineSave("contact_email")} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label className="w-40">Contact phone</Label>
            <InlineEdit value={provider.contact_phone || ""} onSave={inlineSave("contact_phone")} />
          </div>
        </CardContent>
      </Card>
    )},
    { key: "danger", label: "Danger zone", icon: AlertOctagon, hidden: !canDelete, content: (
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-[color:var(--color-danger)]">Irreversible actions</CardTitle>
          <CardDescription>These changes are logged in the audit chain and require Super-Admin approval.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {provider.status !== "TERMINATED" ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-[color:var(--color-danger)]/20 bg-[color:var(--color-danger-muted)]/30 p-3">
              <div>
                <div className="text-sm font-medium">Terminate provider</div>
                <div className="text-xs text-[color:var(--color-text-muted)]">Provider can no longer transact. Active merchants must be re-mapped first.</div>
              </div>
              <Button variant="danger" onClick={() => { if (confirm(`Terminate ${provider.code}? This cannot be reversed without a maker-checker request.`)) statusMut.mutate("TERMINATED"); }}>
                <XOctagon className="h-4 w-4" /> Terminate
              </Button>
            </div>
          ) : (
            <Badge variant="danger">Provider is TERMINATED.</Badge>
          )}
        </CardContent>
      </Card>
    )},
  ];

  // ---- Hero meta strip ----
  const meta = (
    <div className="flex flex-wrap items-center gap-2 text-sm text-[color:var(--color-text-muted)]">
      <span className="font-mono">{provider.code}</span>
      <span>·</span><span>{provider.kind}</span>
      <span>·</span><span>{provider.settlement_currency}</span>
      <span>·</span><span>created {formatDateTime(provider.created_at)}</span>
      <span>·</span>
      <Badge variant={statusVariant(provider.kyc_status)}>KYC {provider.kyc_status}</Badge>
      <Badge variant="info">{users.length} users</Badge>
      <Badge variant="info">{docs.length} docs ({verifiedCount}/{REQUIRED_DOCS.length} verified)</Badge>
      <Badge variant="info">{mappings.length} merchants</Badge>
    </div>
  );

  return (
    <>
      <DetailShell
        breadcrumbs={[{ label: "Providers", href: "/providers" }, { label: provider.code }]}
        backHref="/providers"
        title={provider.legal_name}
        subtitle={`Sub-admin reseller · PRODUCT_VISION §3.1`}
        status={{ label: provider.status, variant: statusVariant(provider.status) }}
        meta={meta}
        primaryActions={[
          { label: "Approve KYC", icon: ShieldCheck, hidden: !canAdmin || !kycPending || !allDocsVerified,
            onClick: () => {/* opens dialog below */} },
        ].filter((a) => !a.hidden) as []}
        sideActions={[
          canAdmin && kycPending ? { label: allDocsVerified ? "Approve KYC" : "Mark in review", icon: ShieldCheck, onClick: () => setKycDialog(allDocsVerified ? "APPROVED" : "IN_REVIEW") } : null,
          canAdmin && kycPending ? { label: "Reject KYC", icon: AlertTriangle, variant: "danger" as const, onClick: () => setKycDialog("REJECTED") } : null,
          canUpdate && provider.status === "ACTIVE" ? { label: "Suspend", icon: Pause, variant: "secondary" as const, onClick: () => statusMut.mutate("SUSPENDED"), loading: statusMut.isPending } : null,
          canUpdate && provider.status === "SUSPENDED" ? { label: "Reactivate", icon: Play, onClick: () => statusMut.mutate("ACTIVE"), loading: statusMut.isPending } : null,
          { label: "Open in new tab", icon: ExternalLink, href: `/providers/${id}` },
        ].filter(Boolean) as []}
        tabs={tabs}
      />

      {/* Controlled KYC dialogs — opened by side-rail actions. */}
      {kycDialog && (
        <KycDecisionDialog
          provider={provider}
          decision={kycDialog}
          open={true}
          onOpenChange={(o) => !o && setKycDialog(null)}
          trigger={<></>}
        />
      )}

      {/* L4 — merchant sub-detail drawer */}
      <Drawer open={!!merchantDrawer} onOpenChange={(o) => !o && setMerchantDrawer(null)}>
        <DrawerContent size="md">
          <DrawerHeader>
            <DrawerTitle>Merchant {merchantDrawer?.merchant_id}</DrawerTitle>
            <DrawerDescription>Mapped to {provider.code} · {merchantDrawer?.relation} · since {merchantDrawer ? formatDateTime(merchantDrawer.created_at) : ""}</DrawerDescription>
          </DrawerHeader>
          <DrawerBody>
            {merchantDrawer && (
              <div className="space-y-3 text-sm">
                <div className="rounded-md border bg-[color:var(--color-surface-muted)] p-3">
                  <div className="text-[color:var(--color-text-muted)] text-xs uppercase tracking-wide mb-1">Mapping</div>
                  <div className="flex items-center justify-between">
                    <span>Merchant ID</span><span className="font-mono text-xs">{merchantDrawer.merchant_id}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Relation</span><Badge variant="brand">{merchantDrawer.relation}</Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Mapped at</span><span>{formatDateTime(merchantDrawer.created_at)}</span>
                  </div>
                </div>
                <div>
                  <div className="text-[color:var(--color-text-muted)] text-xs uppercase tracking-wide mb-1">Recent activity</div>
                  <ActivityFeed resourceType="merchant" resourceId={merchantDrawer.merchant_id} limit={10} />
                </div>
                <div className="flex gap-2 pt-2">
                  <Button asChild className="flex-1"><Link href={`/merchants?q=${merchantDrawer.merchant_id}`}>Open merchant page</Link></Button>
                </div>
              </div>
            )}
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    </>
  );
}
