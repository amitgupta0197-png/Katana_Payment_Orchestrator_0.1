"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Store, Plus, ChevronRight, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { DataView } from "@/components/world-class/data-view";
import { RowActions } from "@/components/world-class/row-actions";
import { useCan } from "@/lib/use-access";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Merchant {
  id: string; merchant_code: string; legal_name: string; brand_name?: string;
  business_type?: string; category_mcc?: string; contact_email: string;
  stage: string; risk_tier?: string; created_at: string;
}
interface FunnelRow { stage: string; n: number }

function OnboardDialog({ open: controlledOpen, onOpenChange }: { open?: boolean; onOpenChange?: (o: boolean) => void } = {}) {
  const qc = useQueryClient();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [form, setForm] = useState({
    merchant_code: "M-NEW", legal_name: "New Merchant Pvt Ltd",
    brand_name: "", business_type: "PRIVATE_LIMITED", category_mcc: "5411",
    contact_email: "ops@newmerchant.example", contact_phone: "9999900000",
    website: "https://newmerchant.example", registered_address: "Mumbai, India",
  });
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/merchants", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success("Merchant onboarded — APPLICATION stage");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["merchants"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {controlledOpen === undefined && (
        <DialogTrigger asChild><Button><Plus /> Onboard merchant</Button></DialogTrigger>
      )}
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Onboard merchant — Step 1: Application</DialogTitle>
          <DialogDescription>
            Per PRODUCT_VISION §2.2 step 1. Stage starts at APPLICATION. KYB documents,
            screening, bank verification, config, and approval happen in subsequent stages.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Merchant code</Label>
            <Input value={form.merchant_code} onChange={(e) => setForm({ ...form, merchant_code: e.target.value.toUpperCase() })} />
          </div>
          <div className="space-y-1.5">
            <Label>Brand name</Label>
            <Input value={form.brand_name} onChange={(e) => setForm({ ...form, brand_name: e.target.value })} placeholder="(optional)" />
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>Legal name</Label>
            <Input value={form.legal_name} onChange={(e) => setForm({ ...form, legal_name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Business type</Label>
            <select
              className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]"
              value={form.business_type}
              onChange={(e) => setForm({ ...form, business_type: e.target.value })}
            >
              {["PRIVATE_LIMITED","PUBLIC_LIMITED","LLP","PARTNERSHIP","SOLE_PROPRIETOR","TRUST"].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>MCC</Label>
            <Input value={form.category_mcc} onChange={(e) => setForm({ ...form, category_mcc: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Contact email</Label>
            <Input type="email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Contact phone</Label>
            <Input value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} />
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>Website</Label>
            <Input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>Registered address</Label>
            <Input value={form.registered_address} onChange={(e) => setForm({ ...form, registered_address: e.target.value })} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Creating…" : "Submit application"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const STAGE_ORDER = ["APPLICATION", "DOCS_PENDING", "SCREENING", "BANK_VERIFY", "CONFIG", "LIVE"] as const;

export default function MerchantsPage() {
  const canCreate = useCan("merchants", "create");
  const sp = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => { if (sp.get("new") === "1" && canCreate) setCreateOpen(true); }, [sp, canCreate]);

  const q = useQuery({
    queryKey: ["merchants"],
    queryFn: async () => (await fetch("/api/merchants").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { merchants: Merchant[]; funnel: FunnelRow[] },
  });

  const cols: Column<Merchant>[] = [
    { key: "merchant_code", header: "Code",
      render: (r) => <Link className="text-[color:var(--color-brand)] hover:underline font-medium" href={`/merchants/${r.id}`}>{r.merchant_code}</Link> },
    { key: "legal_name", header: "Legal name" },
    { key: "business_type", header: "Type", render: (r) => r.business_type ?? "—" },
    { key: "contact_email", header: "Contact" },
    { key: "risk_tier", header: "Risk", render: (r) => r.risk_tier ? <Badge variant={statusVariant(r.risk_tier)}>{r.risk_tier}</Badge> : "—" },
    { key: "stage", header: "Stage", render: (r) => <Badge variant={statusVariant(r.stage)}>{r.stage}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  const funnel = q.data?.funnel ?? [];
  const allMerchants = q.data?.merchants ?? [];

  return (
    <>
      <PageHeader
        title="Merchants"
        description="Customer-of-our-customer entities (PRODUCT_VISION §3.3). 6-stage onboarding: APPLICATION → DOCS_PENDING → SCREENING → BANK_VERIFY → CONFIG → LIVE."
        icon={Store}
      />
      {funnel.length > 0 && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Onboarding funnel</CardTitle>
            <CardDescription>Quick visual of where merchants sit. Use filter chips below the toolbar to drill in.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {STAGE_ORDER.map((stage) => {
                const row = funnel.find((f) => f.stage === stage);
                const n = row?.n ?? 0;
                return (
                  <div key={stage} className="rounded-md border p-3">
                    <Badge variant={statusVariant(stage)}>{stage}</Badge>
                    <div className="mt-1 text-xl font-semibold tabular-nums">{n}</div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
      <DataView
        rows={allMerchants}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        href={(r) => `/merchants/${r.id}`}
        search={{ placeholder: "Search by code, name, contact…", fields: ["merchant_code", "legal_name", "contact_email", "business_type"] }}
        filters={STAGE_ORDER.map((s) => ({ key: s, label: s, predicate: (r: Merchant) => r.stage === s }))}
        modes={["table", "kanban"]}
        kanbanColumn={(r) => r.stage}
        kanbanColumns={STAGE_ORDER.map((s) => ({ key: s, label: s }))}
        renderCard={(r) => (
          <Link href={`/merchants/${r.id}`} className="block rounded-md border bg-[color:var(--color-surface)] p-2 text-sm hover:bg-[color:var(--color-surface-muted)]">
            <div className="flex items-center justify-between">
              <Badge variant="brand">{r.merchant_code}</Badge>
              {r.risk_tier && <Badge variant={statusVariant(r.risk_tier)}>{r.risk_tier}</Badge>}
            </div>
            <div className="mt-1 truncate font-medium">{r.legal_name}</div>
            <div className="mt-0.5 truncate text-xs text-[color:var(--color-text-muted)]">{r.contact_email}</div>
          </Link>
        )}
        fab={canCreate ? { label: "Onboard merchant", icon: Plus, onClick: () => setCreateOpen(true) } : undefined}
        refresh={() => q.refetch()}
        savedViewKey="merchants"
        emptyTitle="No merchants onboarded yet"
        emptyDescription="Submit the first application to kick off the 6-stage pipeline."
        rowActions={(r) => (
          <RowActions
            openHref={`/merchants/${r.id}`}
            actions={[
              { label: "Open detail", icon: ExternalLink, onClick: () => (window.location.href = `/merchants/${r.id}`) },
            ]}
          />
        )}
      />
      <OnboardDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
