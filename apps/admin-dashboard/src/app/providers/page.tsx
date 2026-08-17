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

// Stored enum values (providers.kind CHECK constraint) shown in the current vocabulary.
// PROVIDER is the party the UI now calls "Merchant" — the value cannot be renamed without
// a data migration, so only the label changes here.
const KIND_OPTIONS = [
  { value: "PROVIDER",  label: "Merchant" },
  { value: "AGENT",     label: "Agent" },
  { value: "PARTNER",   label: "Partner" },
  { value: "FRANCHISE", label: "Franchise" },
];

interface IssuedLogin { email?: string; password?: string | null; existing?: boolean; error?: string; banker_id?: string }
interface CreateResult {
  code: string;
  provider_login?: IssuedLogin;
  banker_login?: IssuedLogin;
  branch?: { merchant_code?: string; login?: IssuedLogin; error?: string };
}

function CredentialLine({ title, login }: { title: string; login?: IssuedLogin }) {
  if (!login) return null;
  if (login.error) return <div className="text-xs text-[color:var(--color-danger)]">{title}: {login.error}</div>;
  return (
    <div className="rounded-md border bg-[color:var(--color-surface)] p-2 text-xs space-y-0.5">
      <div className="font-semibold">{title}</div>
      <div>Email: <b>{login.email}</b></div>
      {login.password
        ? <div>One-time password: <b className="font-mono">{login.password}</b></div>
        : <div className="text-[color:var(--color-text-muted)]">Existing account — signs in with its current password.</div>}
    </div>
  );
}

function CreateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    code: "PRV-XXX", legal_name: "New Partner Pvt Ltd",
    contact_email: "ops@partner.example", contact_phone: "9999988888",
    kind: "PROVIDER",
  });
  const [withProviderLogin, setWithProviderLogin] = useState(true);
  const [withBanker, setWithBanker] = useState(false);
  const [bankerEmail, setBankerEmail] = useState("");
  const [withBranch, setWithBranch] = useState(false);
  const [branch, setBranch] = useState({ merchant_code: "", legal_name: "", contact_email: "" });
  const [result, setResult] = useState<CreateResult | null>(null);

  const m = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { ...form, create_provider_login: withProviderLogin };
      if (withBanker) { body.create_banker_login = true; if (bankerEmail.trim()) body.banker_email = bankerEmail.trim(); }
      if (withBranch) {
        body.initial_branch = {
          merchant_code: branch.merchant_code.trim(),
          legal_name: branch.legal_name.trim() || `${form.legal_name} Banker`,
          ...(branch.contact_email.trim() ? { contact_email: branch.contact_email.trim() } : {}),
        };
      }
      const r = await fetch("/api/providers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as CreateResult;
    },
    onSuccess: (d) => {
      toast.success("Merchant created");
      qc.invalidateQueries({ queryKey: ["providers"] });
      if (d.provider_login || d.banker_login || d.branch) setResult(d);
      else onOpenChange(false);
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const close = () => { onOpenChange(false); setResult(null); };

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setResult(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Create merchant</DialogTitle>
          <DialogDescription>
            {result
              ? "Share these credentials now — one-time passwords are shown only once."
              : "Kind: Merchant, Agent, Partner or Franchise. Optionally provision the merchant login, DT banker login and first banker in one go."}
          </DialogDescription></DialogHeader>
        {result ? (
          <div className="space-y-2">
            <CredentialLine title={`Merchant login (${result.code})`} login={result.provider_login} />
            <CredentialLine title={`DT banker login (${result.banker_login?.banker_id ?? result.code})`} login={result.banker_login} />
            {result.branch?.error
              ? <div className="text-xs text-[color:var(--color-danger)]">Banker: {result.branch.error}</div>
              : <CredentialLine title={`Banker login (${result.branch?.merchant_code ?? ""})`} login={result.branch?.login} />}
            <p className="text-xs text-[color:var(--color-text-muted)]">Everyone signs in at /login — merchant lands in the merchant portal, banker in the banker portal, DT banker in the DT banker portal.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              {(["code","legal_name","contact_email","contact_phone","kind"] as const).map((k) => (
                <div key={k} className={k === "legal_name" ? "space-y-1.5 col-span-2" : "space-y-1.5"}>
                  <Label>{k.replace(/_/g," ")}</Label>
                  {k === "kind" ? (
                    // `kind` is a stored enum with a CHECK constraint — PROVIDER/AGENT/
                    // PARTNER/FRANCHISE. It was a free-text box, so after the rename the
                    // obvious thing to type here ("MERCHANT") was rejected by the API. Show
                    // the new vocabulary, send the stored value.
                    <select
                      className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]"
                      value={form.kind}
                      onChange={(e) => setForm({ ...form, kind: e.target.value })}
                    >
                      {KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <Input value={(form as Record<string, string>)[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                  )}
                </div>
              ))}
            </div>
            <div className="space-y-2 rounded-md border p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">Also provision</div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={withProviderLogin} onChange={(e) => setWithProviderLogin(e.target.checked)} />
                Merchant login (uses contact email)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={withBanker} onChange={(e) => setWithBanker(e.target.checked)} />
                DT banker login (banker id = merchant code)
              </label>
              {withBanker && (
                <div className="space-y-1.5 pl-6">
                  <Label>DT banker email <span className="text-[color:var(--color-text-subtle)]">(blank = contact email)</span></Label>
                  <Input type="email" value={bankerEmail} onChange={(e) => setBankerEmail(e.target.value)} placeholder="banker@example.com" />
                </div>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={withBranch} onChange={(e) => setWithBranch(e.target.checked)} />
                First banker (mapped to this merchant)
              </label>
              {withBranch && (
                <div className="grid grid-cols-2 gap-3 pl-6">
                  <div className="space-y-1.5"><Label>Banker code</Label><Input value={branch.merchant_code} onChange={(e) => setBranch({ ...branch, merchant_code: e.target.value })} placeholder="e.g. BR-001" /></div>
                  <div className="space-y-1.5"><Label>Banker name</Label><Input value={branch.legal_name} onChange={(e) => setBranch({ ...branch, legal_name: e.target.value })} /></div>
                  <div className="space-y-1.5 col-span-2"><Label>DT banker email <span className="text-[color:var(--color-text-subtle)]">(blank = contact email)</span></Label><Input type="email" value={branch.contact_email} onChange={(e) => setBranch({ ...branch, contact_email: e.target.value })} /></div>
                </div>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={close}>{result ? "Done" : "Cancel"}</Button>
          {!result && (
            <Button onClick={() => m.mutate()} disabled={m.isPending || (withBranch && !branch.merchant_code.trim())}>
              {m.isPending ? "Creating…" : "Create"}
            </Button>
          )}
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

  // Cmd+K "New merchant" deep-link.
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

  // BULK ACTIONS RUN PER ROW, and report per row.
  //
  // There is no batch endpoint, and inventing one would hide the interesting part: some rows
  // legitimately refuse. A delete is declined for an APPROVED merchant or one carrying settlement
  // history (the API answers 409 with a reason), so "18 selected" can end as "15 deleted, 3
  // skipped" — and the operator has to be told which, or they will assume it all worked.
  const [bulkBusy, setBulkBusy] = useState(false);
  const runBulk = async (
    ids: string[],
    verb: string,
    run: (id: string) => Promise<Response>,
  ) => {
    setBulkBusy(true);
    const skipped: string[] = [];
    let done = 0;
    // Sequential: 18 concurrent writes against one Postgres pool is how you turn a tidy-up into
    // an outage, and the list is small enough that it costs a second.
    for (const id of ids) {
      try {
        const r = await run(id);
        const d = await r.json().catch(() => ({}));
        if (r.ok) done++;
        else skipped.push(`${d.code ?? id.slice(0, 8)}: ${d.error ?? `HTTP ${r.status}`}`);
      } catch (e) {
        skipped.push(`${id.slice(0, 8)}: ${(e as Error).message}`);
      }
    }
    setBulkBusy(false);
    qc.invalidateQueries({ queryKey: ["providers"] });
    if (done && !skipped.length) toast.success(`${done} merchant${done === 1 ? "" : "s"} ${verb}`);
    else if (done) toast.warning(`${done} ${verb}, ${skipped.length} skipped`, { description: skipped.slice(0, 4).join(" · ") });
    else toast.error(`Nothing ${verb}`, { description: skipped.slice(0, 4).join(" · ") });
  };

  const cols: Column<Provider>[] = [
    { key: "code", header: "Code",
      render: (r) => <Link className="text-[color:var(--color-brand)] hover:underline font-medium" href={`/providers/${r.id}`}>{r.code}</Link> },
    { key: "legal_name", header: "Legal name",
      render: (r) => <Link className="hover:underline" href={`/providers/${r.id}`}>{r.legal_name}</Link> },
    { key: "kind", header: "Kind" },
    { key: "kyc_status", header: "KYC", render: (r) => <Badge variant={statusVariant(r.kyc_status)}>{r.kyc_status}</Badge> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "merchant_count", header: "Bankers" },
    { key: "contact_email", header: "Contact" },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  const rows = q.data?.providers ?? [];

  return (
    <>
      <PageHeader
        title="Merchants"
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
        fab={canCreate ? { label: "Merchant", icon: Plus, onClick: () => setCreateOpen(true) } : undefined}
        refresh={() => q.refetch()}
        savedViewKey="providers"
        emptyTitle="No merchants yet"
        emptyDescription="Onboard your first reseller to start the KYC lifecycle."
        bulkActions={canUpdate || canDelete ? [
          ...(canUpdate ? [{ label: "Suspend", icon: Archive, variant: "secondary" as const, disabled: bulkBusy,
            onClick: (ids: string[]) => {
              if (!ids.length) return;
              if (!confirm(`Suspend ${ids.length} merchant${ids.length === 1 ? "" : "s"}? They stop transacting until reactivated.`)) return;
              runBulk(ids, "suspended", (id) => fetch(`/api/providers/${id}`, {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "SUSPENDED" }),
              }));
            } }] : []),
          ...(canDelete ? [{ label: "Delete", icon: Trash2, variant: "danger" as const, disabled: bulkBusy,
            onClick: (ids: string[]) => {
              if (!ids.length) return;
              // Named codes, not just a count: this is irreversible, and "18 selected" is easy to
              // mis-read after filtering. Approved merchants and any row with settlement history
              // are refused by the API and reported back as skipped.
              const codes = rows.filter((r) => ids.includes(r.id)).map((r) => r.code);
              const shown = codes.slice(0, 8).join(", ") + (codes.length > 8 ? `, +${codes.length - 8} more` : "");
              if (!confirm(
                `Permanently delete ${ids.length} merchant${ids.length === 1 ? "" : "s"}?\n\n${shown}\n\n`
                + "This cannot be undone. Their bankers are unmapped but not deleted. "
                + "Merchants with approved KYC or settlement history will be skipped — terminate those instead.",
              )) return;
              runBulk(ids, "deleted", (id) => fetch(`/api/providers/${id}`, { method: "DELETE" }));
            } }] : []),
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
