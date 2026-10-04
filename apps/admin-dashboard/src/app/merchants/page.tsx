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
import { DataView } from "@/components/world-class/data-view";
import { RowActions, ACT } from "@/components/world-class/row-actions";
import { useCan } from "@/lib/use-access";
import { formatDateTime, statusVariant } from "@/lib/utils";
import { ServicesBadge } from "@/components/merchant/services";
import { MerchantWizard } from "@/components/merchant/onboarding-wizard";
import { FlowBadge } from "@/components/payin/flow";
import type { MerchantServicesSetting } from "@/lib/merchant-services";
import type { OrderFlow, PayinFlowSetting } from "@/lib/payin-flow";
import { HealthRing, useHealthScores } from "@/components/health/health-ring";

interface Provider {
  services?: MerchantServicesSetting; payin_flow?: PayinFlowSetting; payin_active_flow?: OrderFlow | null;
  id: string; code: string; legal_name: string; contact_email: string;
  kind: string; kyc_status: string; status: string; settlement_currency: string;
  user_count: number; doc_count: number; merchant_count: number; created_at: string;
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

  // Health from the cache, one call for the whole list (staff only: hidden when not allowed).
  const health = useHealthScores("MERCHANT", q.data ? q.data.providers.map((p) => p.id) : [], { enabled: !!q.data });

  const cols: Column<Provider>[] = [
    ...(health.data === null ? [] : [{ key: "health", header: "Health",
      render: (r: Provider) => <HealthRing type="MERCHANT" id={r.id} label={r.code} row={health.data?.get(r.id) ?? null} /> }]),
    { key: "code", header: "Code",
      render: (r) => <Link className="text-[color:var(--color-brand)] hover:underline font-medium" href={`/merchants/${r.id}`}>{r.code}</Link> },
    { key: "legal_name", header: "Legal name",
      render: (r) => <Link className="hover:underline" href={`/merchants/${r.id}`}>{r.legal_name}</Link> },
    { key: "kind", header: "Kind" },
    { key: "services", header: "Services", render: (r) => <ServicesBadge services={r.services ?? "UNSET"} /> },
    { key: "payin_flow", header: "Pay-in flow",
      render: (r) => r.services === "PAYOUT" ? <span className="text-[color:var(--color-text-muted)]">—</span>
        : <FlowBadge flow={r.payin_flow ?? "UNSET"} active={r.payin_active_flow} /> },
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
          { key: "svc:payin",    label: "Takes pay-ins", predicate: (r) => r.services === "PAYIN" || r.services === "BOTH" },
          { key: "svc:payout",   label: "Sends payouts", predicate: (r) => r.services === "PAYOUT" || r.services === "BOTH" },
          { key: "svc:unset",    label: "Nothing selected", predicate: (r) => (r.services ?? "UNSET") === "UNSET" },
        ]}
        href={(r) => `/merchants/${r.id}`}
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
            openHref={`/merchants/${r.id}`}
            actions={[
              ...(canUpdate ? [ACT.edit(() => (window.location.href = `/merchants/${r.id}?tab=settings`))] : []),
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
      <MerchantWizard mode="create" open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
