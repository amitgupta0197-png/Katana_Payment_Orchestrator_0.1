"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Store, Plus, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Merchant {
  id: string; merchant_code: string; legal_name: string; brand_name?: string;
  business_type?: string; category_mcc?: string; contact_email: string;
  stage: string; risk_tier?: string; created_at: string;
}
interface FunnelRow { stage: string; n: number }

function OnboardDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
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
      <DialogTrigger asChild><Button><Plus /> Onboard merchant</Button></DialogTrigger>
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
  const q = useQuery({
    queryKey: ["merchants"],
    queryFn: async () => (await fetch("/api/merchants").then((r) => r.json())) as { merchants: Merchant[]; funnel: FunnelRow[] },
  });
  const [stageFilter, setStageFilter] = useState<string | null>(null);

  const cols: Column<Merchant>[] = [
    {
      key: "merchant_code", header: "Code",
      render: (r) => <Link className="text-[color:var(--color-brand)] hover:underline" href={`/merchants/${r.id}`}>{r.merchant_code}</Link>,
    },
    { key: "legal_name", header: "Legal name" },
    { key: "business_type", header: "Type", render: (r) => r.business_type ?? "—" },
    { key: "contact_email", header: "Contact" },
    { key: "risk_tier", header: "Risk", render: (r) => r.risk_tier ? <Badge variant={statusVariant(r.risk_tier)}>{r.risk_tier}</Badge> : "—" },
    { key: "stage", header: "Stage", render: (r) => <Badge variant={statusVariant(r.stage)}>{r.stage}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
    {
      key: "actions", header: "",
      render: (r) => (
        <Link href={`/merchants/${r.id}`} className="inline-flex items-center text-xs text-[color:var(--color-text-muted)] hover:text-[color:var(--color-brand)]">
          Open <ChevronRight className="h-3 w-3" />
        </Link>
      ),
    },
  ];

  const funnel = q.data?.funnel ?? [];
  const allMerchants = q.data?.merchants ?? [];
  const filtered = stageFilter ? allMerchants.filter((m) => m.stage === stageFilter) : allMerchants;

  return (
    <>
      <PageHeader
        title="Merchants"
        description="Customer-of-our-customer entities (PRODUCT_VISION §3.3). Onboarding stages: APPLICATION → DOCS_PENDING → SCREENING → BANK_VERIFY → CONFIG → LIVE."
        icon={Store}
        actions={<OnboardDialog />}
      />
      {funnel.length > 0 && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Onboarding funnel</CardTitle>
            <CardDescription>Click a stage to filter the list below.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {STAGE_ORDER.map((stage) => {
                const row = funnel.find((f) => f.stage === stage);
                const n = row?.n ?? 0;
                const active = stageFilter === stage;
                return (
                  <button
                    key={stage}
                    onClick={() => setStageFilter(active ? null : stage)}
                    className={`text-left rounded-md border p-3 transition-colors ${active ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)]" : "hover:bg-[color:var(--color-surface-muted)]"}`}
                  >
                    <Badge variant={statusVariant(stage)}>{stage}</Badge>
                    <div className="mt-1 text-xl font-semibold">{n}</div>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            {filtered.length} {stageFilter ? `${stageFilter} ` : ""}merchant{filtered.length === 1 ? "" : "s"}
            {stageFilter && (
              <button onClick={() => setStageFilter(null)} className="ml-3 text-xs font-normal text-[color:var(--color-brand)] hover:underline">clear filter</button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable columns={cols} rows={filtered} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No merchants match this filter." />
        </CardContent>
      </Card>
    </>
  );
}
