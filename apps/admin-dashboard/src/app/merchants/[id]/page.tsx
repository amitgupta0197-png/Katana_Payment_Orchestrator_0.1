"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Store, ChevronLeft, CheckCircle2, Circle, ArrowRight, AlertTriangle } from "lucide-react";
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
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Merchant {
  id: string; merchant_code: string; legal_name: string; brand_name?: string;
  business_type?: string; category_mcc?: string; contact_email: string;
  stage: string; risk_tier?: string;
  step_application: boolean; step_kyb_docs: boolean; step_screening: boolean;
  step_bank_verify: boolean; step_config: boolean; step_approval: boolean;
  created_at: string; approved_at?: string; approved_by?: string;
}
interface SubMid {
  id: string; sub_mid_code: string; merchant_id: string;
  kyc_status: string; settlement_enabled: boolean; traffic_mode: string; main_mid_code: string;
}

const STEPS = [
  { key: "step_application",  stage_from: "APPLICATION",   stage_to: "DOCS_PENDING",  label: "Application",     description: "Basic merchant details captured." },
  { key: "step_kyb_docs",     stage_from: "DOCS_PENDING",  stage_to: "SCREENING",     label: "KYB documents",   description: "PAN, GST, CIN, MOA, AOA, board resolution, bank statement, MCC declaration uploaded." },
  { key: "step_screening",    stage_from: "SCREENING",     stage_to: "BANK_VERIFY",   label: "Screening",       description: "OFAC / UN / EU / FATF sanctions screening. Risk tier assigned." },
  { key: "step_bank_verify",  stage_from: "BANK_VERIFY",   stage_to: "CONFIG",        label: "Bank verify",     description: "Penny-drop on settlement account. Beneficiary name-match validated." },
  { key: "step_config",       stage_from: "CONFIG",        stage_to: "CONFIG",        label: "Configuration",   description: "Main MID created. Rails enabled. Webhook URL set." },
  { key: "step_approval",     stage_from: "CONFIG",        stage_to: "LIVE",          label: "Approval & go-live", description: "Super-Admin final review. Sub-MIDs settlement-enabled. API key issued." },
] as const;

function AdvanceDialog({ merchant, stepIndex }: { merchant: Merchant; stepIndex: number }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const step = STEPS[stepIndex];
  const [notes, setNotes] = useState("");
  const [riskTier, setRiskTier] = useState<"LOW" | "MEDIUM" | "HIGH">(merchant.risk_tier as any ?? "LOW");

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/merchants/${merchant.id}/advance`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: step.key, notes, risk_tier: step.key === "step_screening" ? riskTier : undefined }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success(`Advanced to ${step.stage_to}`);
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["merchant", merchant.id] });
      qc.invalidateQueries({ queryKey: ["merchants"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><ArrowRight className="h-4 w-4" /> {step.label}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Advance — {step.label}</DialogTitle>
          <DialogDescription>
            Move {merchant.merchant_code} from <Badge variant={statusVariant(step.stage_from)}>{step.stage_from}</Badge> to{" "}
            <Badge variant={statusVariant(step.stage_to)}>{step.stage_to}</Badge>. {step.description}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {step.key === "step_screening" && (
            <div className="space-y-1.5">
              <Label>Risk tier (post-screening)</Label>
              <select
                className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]"
                value={riskTier} onChange={(e) => setRiskTier(e.target.value as any)}
              >
                <option value="LOW">LOW</option>
                <option value="MEDIUM">MEDIUM</option>
                <option value="HIGH">HIGH</option>
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Operator notes (audit log)</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. 'docs verified by ops on 13-Jun'" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Advancing…" : "Confirm advance"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectButton({ merchant }: { merchant: Merchant }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/merchants/${merchant.id}/advance`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reject: true, notes: "rejected by admin" }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success("Merchant rejected");
      qc.invalidateQueries({ queryKey: ["merchant", merchant.id] });
      qc.invalidateQueries({ queryKey: ["merchants"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  if (merchant.stage === "LIVE" || merchant.stage === "REJECTED" || merchant.stage === "TERMINATED") return null;
  return (
    <Button variant="danger" size="sm" onClick={() => m.mutate()} disabled={m.isPending}>
      <AlertTriangle className="h-4 w-4" /> Reject
    </Button>
  );
}

export default function MerchantDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const merchantQ = useQuery({
    queryKey: ["merchant", id],
    queryFn: async () => {
      const all = (await fetch("/api/merchants").then((r) => r.json())) as { merchants: Merchant[] };
      return all.merchants.find((m) => m.id === id) ?? null;
    },
  });
  const subMidsQ = useQuery({
    queryKey: ["merchant", id, "sub-mids"],
    queryFn: async () => (await fetch("/api/sub-mids").then((r) => r.json())) as { sub_mids: SubMid[] },
  });

  const merchant = merchantQ.data;

  if (merchantQ.isLoading) {
    return <Card><CardContent className="py-8 text-center text-sm text-[color:var(--color-text-muted)]">Loading…</CardContent></Card>;
  }
  if (!merchant) {
    return (
      <>
        <PageHeader title="Merchant not found" description="" icon={Store} />
        <Card><CardContent className="py-8 text-center"><Link className="text-[color:var(--color-brand)] hover:underline" href="/merchants">← back to merchants</Link></CardContent></Card>
      </>
    );
  }

  // Find which step is next to advance.
  const stepsDone = STEPS.map((s) => merchant[s.key as keyof Merchant] as boolean);
  const nextStepIndex = stepsDone.findIndex((d) => !d);
  const nextStep = nextStepIndex >= 0 ? STEPS[nextStepIndex] : null;

  const ownSubs = (subMidsQ.data?.sub_mids ?? []).filter((s) => s.merchant_id === merchant.merchant_code || s.merchant_id === merchant.id);
  const subCols: Column<SubMid>[] = [
    { key: "sub_mid_code", header: "Sub-MID" },
    { key: "main_mid_code", header: "Main MID" },
    { key: "traffic_mode", header: "Mode", render: (r) => <Badge variant={statusVariant(r.traffic_mode)}>{r.traffic_mode}</Badge> },
    { key: "kyc_status", header: "KYC", render: (r) => <Badge variant={statusVariant(r.kyc_status)}>{r.kyc_status}</Badge> },
    { key: "settlement_enabled", header: "Settle?", render: (r) => r.settlement_enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
  ];

  return (
    <>
      <PageHeader
        title={merchant.brand_name || merchant.legal_name}
        description={`${merchant.merchant_code} · ${merchant.business_type ?? "—"} · MCC ${merchant.category_mcc ?? "—"} · created ${formatDateTime(merchant.created_at)}`}
        icon={Store}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(merchant.stage)}>{merchant.stage}</Badge>
            {merchant.risk_tier && <Badge variant={statusVariant(merchant.risk_tier)}>{merchant.risk_tier}</Badge>}
            <Link href="/merchants" className="text-xs text-[color:var(--color-text-muted)] hover:text-[color:var(--color-brand)] inline-flex items-center"><ChevronLeft className="h-3 w-3" /> back</Link>
          </div>
        }
      />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Onboarding journey</CardTitle>
          <CardDescription>6-step funnel per PRODUCT_VISION §2.2.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3">
            {STEPS.map((step, idx) => {
              const done = stepsDone[idx];
              const isNext = idx === nextStepIndex && merchant.stage !== "REJECTED" && merchant.stage !== "TERMINATED";
              return (
                <li key={step.key} className={`flex items-start gap-3 rounded-md border p-3 ${isNext ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)]" : ""}`}>
                  <span className="mt-0.5">
                    {done ? <CheckCircle2 className="h-5 w-5 text-[color:var(--color-success)]" /> : <Circle className="h-5 w-5 text-[color:var(--color-text-subtle)]" />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{idx + 1}. {step.label}</div>
                    <div className="text-xs text-[color:var(--color-text-muted)] mt-0.5">{step.description}</div>
                  </div>
                  {isNext && <AdvanceDialog merchant={merchant} stepIndex={idx} />}
                  {done && <Badge variant="success" className="self-center">done</Badge>}
                </li>
              );
            })}
          </ol>
          {nextStep === null && merchant.stage !== "REJECTED" && (
            <div className="mt-4 rounded-md border border-[color:var(--color-success)]/30 bg-[color:var(--color-success-muted)] px-3 py-2 text-xs text-[color:var(--color-success)]">
              All six onboarding steps complete. Merchant is LIVE.
            </div>
          )}
          {merchant.stage === "REJECTED" && (
            <div className="mt-4 rounded-md border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger-muted)] px-3 py-2 text-xs text-[color:var(--color-danger)]">
              Merchant onboarding was rejected. No further advancement possible.
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 mb-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Identity</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div><span className="text-[color:var(--color-text-muted)]">Code:</span> <span className="font-mono">{merchant.merchant_code}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">Legal name:</span> {merchant.legal_name}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Brand:</span> {merchant.brand_name ?? "—"}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Business type:</span> {merchant.business_type ?? "—"}</div>
            <div><span className="text-[color:var(--color-text-muted)]">MCC:</span> {merchant.category_mcc ?? "—"}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Risk tier:</span> {merchant.risk_tier ? <Badge variant={statusVariant(merchant.risk_tier)}>{merchant.risk_tier}</Badge> : "—"}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Contact</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div><span className="text-[color:var(--color-text-muted)]">Email:</span> {merchant.contact_email}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Approved at:</span> {merchant.approved_at ? formatDateTime(merchant.approved_at) : "—"}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Approved by:</span> {merchant.approved_by || "—"}</div>
            <div className="pt-3"><RejectButton merchant={merchant} /></div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Sub-MIDs ({ownSubs.length})</CardTitle><CardDescription>MID surface configured for this merchant.</CardDescription></CardHeader>
        <CardContent>
          <DataTable columns={subCols} rows={ownSubs} loading={subMidsQ.isLoading} rowKey={(r) => r.id} emptyState="No Sub-MIDs yet. Create one at /sub-mids after CONFIG stage." />
        </CardContent>
      </Card>
    </>
  );
}
