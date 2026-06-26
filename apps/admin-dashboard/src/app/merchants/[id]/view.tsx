"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Store, ChevronLeft, CheckCircle2, Circle, ArrowRight, AlertTriangle, KeyRound, Copy, Upload, FileText } from "lucide-react";
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
import { ProviderAttributionCard } from "@/components/merchant/assign-provider";
import { PaymentMethodsCard, PoolPayConfigCard } from "@/components/merchant/payment-config";
import { PayinOperationsCard } from "@/components/merchant/payin-operations";
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
interface ApiKey {
  id: string; label: string; prefix: string; scopes: string[]; status: string;
  created_at: string; last_used_at?: string; revoked_at?: string;
}
interface GatewayMidStatus {
  configured: boolean; gateway?: string; mid_code?: string; scheme?: string; env?: string; key_hint?: string;
}
interface CheckoutCredsStatus {
  configured: boolean; key?: string; scheme?: string; salt_hint?: string;
}

const STEPS = [
  { key: "step_application",  stage_from: "APPLICATION",   stage_to: "DOCS_PENDING",  label: "Application",     description: "Basic merchant details captured." },
  { key: "step_kyb_docs",     stage_from: "DOCS_PENDING",  stage_to: "SCREENING",     label: "KYB documents",   description: "PAN, GST, CIN, MOA, AOA, board resolution, bank statement, MCC declaration uploaded." },
  { key: "step_screening",    stage_from: "SCREENING",     stage_to: "BANK_VERIFY",   label: "Screening",       description: "OFAC / UN / EU / FATF sanctions screening. Risk tier assigned." },
  { key: "step_bank_verify",  stage_from: "BANK_VERIFY",   stage_to: "CONFIG",        label: "Bank verify",     description: "Penny-drop on settlement account. Beneficiary name-match validated." },
  { key: "step_config",       stage_from: "CONFIG",        stage_to: "CONFIG",        label: "Configuration",   description: "Main MID created. Rails enabled. Webhook URL set." },
  { key: "step_approval",     stage_from: "CONFIG",        stage_to: "LIVE",          label: "Approval & go-live", description: "Super-Admin final review. Sub-MIDs settlement-enabled. API key issued." },
] as const;

// KYB document uploader shown in the DOCS_PENDING advance step. Lets the operator
// attach PAN/GST/CIN/MOA/etc. before (or instead of just flag-toggling) advancing.
function KybDocUploader({ merchantId }: { merchantId: string }) {
  const qc = useQueryClient();
  const [docType, setDocType] = useState("PAN");
  const [file, setFile] = useState<File | null>(null);
  const q = useQuery({
    queryKey: ["merchant-kyb-docs", merchantId],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/documents`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { documents: any[]; doc_types: string[] };
    },
  });
  const up = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("choose a file");
      const fd = new FormData();
      fd.append("doc_type", docType);
      fd.append("file", file);
      const r = await fetch(`/api/merchants/${merchantId}/documents`, { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d;
    },
    onSuccess: () => { toast.success("Document uploaded"); setFile(null); qc.invalidateQueries({ queryKey: ["merchant-kyb-docs", merchantId] }); },
    onError: (e: Error) => toast.error("Upload failed", { description: e.message }),
  });
  const types = q.data?.doc_types ?? ["PAN", "GST", "CIN", "MOA", "AOA", "BOARD_RESOLUTION", "BANK_STATEMENT", "MCC_DECLARATION", "OTHER"];
  const docs = q.data?.documents ?? [];
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <Label>KYB documents</Label>
        {docs.length > 0 && <Badge variant="info">{docs.length} uploaded</Badge>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={docType} onChange={(e) => setDocType(e.target.value)}
          className="h-9 rounded-md border px-2 text-sm bg-[color:var(--color-surface)]"
        >
          {types.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
        </select>
        <input
          type="file" accept=".pdf,image/png,image/jpeg,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm file:mr-2 file:rounded file:border-0 file:bg-[color:var(--color-muted)] file:px-2 file:py-1 file:text-sm"
        />
        <Button size="sm" type="button" variant="secondary" disabled={!file || up.isPending} onClick={() => up.mutate()}>
          <Upload className="h-4 w-4" /> {up.isPending ? "Uploading…" : "Upload"}
        </Button>
      </div>
      {docs.length > 0 && (
        <ul className="space-y-1 text-xs">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center gap-2">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <Badge variant="success">{d.doc_type}</Badge>
              <span className="truncate">{d.filename ?? "file"}</span>
              <span className="font-mono text-[color:var(--color-text-muted)]">{String(d.sha256).slice(0, 10)}…</span>
              <span className="ml-auto text-[color:var(--color-text-muted)]">{formatDateTime(d.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-[color:var(--color-text-muted)]">
        PAN, GST, CIN, MOA, AOA, board resolution, bank statement, MCC declaration. PDF/PNG/JPEG/WEBP up to 12MB.
      </p>
    </div>
  );
}

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
          {step.key === "step_kyb_docs" && <KybDocUploader merchantId={merchant.id} />}
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

function IssueApiKeyDialog({ merchant }: { merchant: Merchant }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/merchants/${merchant.id}/api-keys/issue`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() || undefined, scopes: [] }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json() as Promise<{ key: ApiKey; secret: string }>;
    },
    onSuccess: (d) => {
      setSecret(d.secret);
      qc.invalidateQueries({ queryKey: ["merchant", merchant.id, "api-keys"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  function close() {
    setOpen(false);
    setTimeout(() => { setSecret(null); setLabel(""); m.reset(); }, 200);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <Button size="sm"><KeyRound className="h-4 w-4" /> Generate API key</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate API key</DialogTitle>
          <DialogDescription>
            Issue a live secret for <span className="font-mono">{merchant.merchant_code}</span>. The full secret is shown once and cannot be retrieved later.
          </DialogDescription>
        </DialogHeader>
        {secret ? (
          <div className="space-y-3">
            <div className="rounded-md border border-[color:var(--color-success)]/30 bg-[color:var(--color-success-muted)] px-3 py-2 text-xs text-[color:var(--color-success)]">
              Key created. Copy it now — you won’t be able to see it again.
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-xs font-mono">{secret}</code>
              <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard?.writeText(secret); toast.success("Copied to clipboard"); }}>
                <Copy className="h-4 w-4" /> Copy
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label>Label (optional)</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`${merchant.merchant_code} key`} />
          </div>
        )}
        <DialogFooter>
          {secret ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={close}>Cancel</Button>
              <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Generating…" : "Generate"}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApiKeysCard({ merchant }: { merchant: Merchant }) {
  const isLive = merchant.stage === "LIVE";
  const keysQ = useQuery({
    queryKey: ["merchant", merchant.id, "api-keys"],
    queryFn: async () => (await fetch(`/api/merchants/${merchant.id}/api-keys`).then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { keys: ApiKey[] },
    enabled: isLive,
  });
  const keys = keysQ.data?.keys ?? [];
  const cols: Column<ApiKey>[] = [
    { key: "label", header: "Label" },
    { key: "prefix", header: "Key", render: (r) => <span className="font-mono text-xs">{r.prefix}…</span> },
    { key: "scopes", header: "Scopes", render: (r) => r.scopes?.length ? r.scopes.join(", ") : "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
    { key: "last_used_at", header: "Last used", render: (r) => r.last_used_at ? formatDateTime(r.last_used_at) : "—" },
  ];
  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">API keys</CardTitle>
          <CardDescription>Live secret keys for this merchant. Only the prefix is stored — copy the full secret when it’s issued.</CardDescription>
        </div>
        {isLive && <IssueApiKeyDialog merchant={merchant} />}
      </CardHeader>
      <CardContent>
        {isLive ? (
          <DataTable columns={cols} rows={keys} loading={keysQ.isLoading} rowKey={(r) => r.id} emptyState="No API keys yet. Click “Generate API key” to issue one." />
        ) : (
          <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">
            API keys can be generated once the merchant reaches the LIVE stage.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CheckoutKeyCard({ merchant }: { merchant: Merchant }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [scheme, setScheme] = useState("PAYU_SHA512");
  const [issued, setIssued] = useState<{ key: string; salt: string; scheme: string } | null>(null);

  const statusQ = useQuery({
    queryKey: ["merchant", merchant.id, "checkout-key"],
    queryFn: async () => (await fetch(`/api/merchants/${merchant.id}/checkout-key`).then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { status: CheckoutCredsStatus },
  });
  const status = statusQ.data?.status;

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/merchants/${merchant.id}/checkout-key`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheme }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json() as Promise<{ creds: { key: string; salt: string; scheme: string } }>;
    },
    onSuccess: (d) => {
      setIssued(d.creds);
      qc.invalidateQueries({ queryKey: ["merchant", merchant.id, "checkout-key"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  function close() {
    setOpen(false);
    setTimeout(() => { setIssued(null); m.reset(); }, 200);
  }
  const copy = (v: string) => { navigator.clipboard?.writeText(v); toast.success("Copied"); };

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">Checkout integration (Key + Salt)</CardTitle>
          <CardDescription>Katana-issued Key + Salt the merchant puts in their checkout to sign orders to Katana. Katana verifies it, then re-signs to the gateway.</CardDescription>
        </div>
        <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
          <DialogTrigger asChild>
            <Button size="sm" variant={status?.configured ? "secondary" : "default"}>
              <KeyRound className="h-4 w-4" /> {status?.configured ? "Regenerate" : "Generate Key + Salt"}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{status?.configured ? "Regenerate" : "Generate"} checkout Key + Salt</DialogTitle>
              <DialogDescription>
                For <span className="font-mono">{merchant.merchant_code}</span>. The Salt is shown once — give both to the merchant for their checkout config. Regenerating invalidates the previous pair.
              </DialogDescription>
            </DialogHeader>
            {issued ? (
              <div className="space-y-3">
                <div className="rounded-md border border-[color:var(--color-success)]/30 bg-[color:var(--color-success-muted)] px-3 py-2 text-xs text-[color:var(--color-success)]">
                  Generated. Copy the Salt now — it won’t be shown again.
                </div>
                <div className="space-y-1.5">
                  <Label>Merchant Key</Label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-xs font-mono">{issued.key}</code>
                    <Button size="sm" variant="secondary" onClick={() => copy(issued.key)}><Copy className="h-4 w-4" /></Button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Merchant Salt</Label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-xs font-mono">{issued.salt}</code>
                    <Button size="sm" variant="secondary" onClick={() => copy(issued.salt)}><Copy className="h-4 w-4" /></Button>
                  </div>
                </div>
                <div className="text-xs text-[color:var(--color-text-muted)]">Scheme: <span className="font-mono">{issued.scheme}</span></div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>Signing scheme</Label>
                <select className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]"
                  value={scheme} onChange={(e) => setScheme(e.target.value)}>
                  <option value="PAYU_SHA512">PAYU_SHA512 (PayU-style checkout)</option>
                  <option value="HMAC_SHA256">HMAC_SHA256</option>
                </select>
              </div>
            )}
            <DialogFooter>
              {issued ? (
                <Button onClick={close}>Done</Button>
              ) : (
                <>
                  <Button variant="secondary" onClick={close}>Cancel</Button>
                  <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Generating…" : "Generate"}</Button>
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {status?.configured ? (
          <div className="text-sm space-y-1">
            <div><span className="text-[color:var(--color-text-muted)]">Key:</span> <span className="font-mono">{status.key}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">Salt:</span> <span className="font-mono">{status.salt_hint}</span> <span className="text-[color:var(--color-text-muted)]">· sealed</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">Scheme:</span> <span className="font-mono">{status.scheme}</span></div>
          </div>
        ) : (
          <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">
            No checkout credentials issued yet. Generate a Key + Salt to hand to the merchant.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GatewayMidCard({ merchant }: { merchant: Merchant }) {
  const qc = useQueryClient();
  const statusQ = useQuery({
    queryKey: ["merchant", merchant.id, "gateway-mid"],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchant.id}/gateway-mid`);
      if (r.status === 403) return { restricted: true as const };
      const _d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status));
      return _d as { status: GatewayMidStatus };
    },
  });
  const restricted = (statusQ.data as { restricted?: boolean })?.restricted;
  const status = (statusQ.data as { status?: GatewayMidStatus })?.status;

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ gateway: "PAYU", mid_code: "", key: "", salt: "", scheme: "PAYU_SHA512", env: "TEST" });

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/merchants/${merchant.id}/gateway-mid`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success("Gateway MID credentials saved");
      setOpen(false);
      setForm({ gateway: "PAYU", mid_code: "", key: "", salt: "", scheme: "PAYU_SHA512", env: "TEST" });
      qc.invalidateQueries({ queryKey: ["merchant", merchant.id, "gateway-mid"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const valid = form.gateway && form.mid_code && form.key && form.salt;

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">Gateway MID credentials</CardTitle>
          <CardDescription>Internal mapping — the gateway’s Main-MID Key + Salt that Katana uses to sign orders on this merchant’s behalf. Stored encrypted; never shown to the merchant.</CardDescription>
        </div>
        {!restricted && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant={status?.configured ? "secondary" : "default"}>
                <KeyRound className="h-4 w-4" /> {status?.configured ? "Rotate" : "Set credentials"}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{status?.configured ? "Rotate" : "Set"} gateway MID credentials</DialogTitle>
                <DialogDescription>
                  Paste the Key + Salt the gateway issued for <span className="font-mono">{merchant.merchant_code}</span>’s Main MID. Stored sealed; used to sign orders to the gateway.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5"><Label>Gateway</Label><Input value={form.gateway} onChange={(e) => setForm({ ...form, gateway: e.target.value })} placeholder="PAYU" /></div>
                  <div className="space-y-1.5"><Label>Main MID code</Label><Input value={form.mid_code} onChange={(e) => setForm({ ...form, mid_code: e.target.value })} placeholder="MID-…" /></div>
                </div>
                <div className="space-y-1.5"><Label>Key</Label><Input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="gateway merchant key" /></div>
                <div className="space-y-1.5"><Label>Salt</Label><Input value={form.salt} onChange={(e) => setForm({ ...form, salt: e.target.value })} placeholder="gateway salt" /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Signing scheme</Label>
                    <select className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]"
                      value={form.scheme} onChange={(e) => setForm({ ...form, scheme: e.target.value })}>
                      <option value="PAYU_SHA512">PAYU_SHA512 (PayU / Airpay)</option>
                      <option value="HMAC_SHA256">HMAC_SHA256</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Environment</Label>
                    <select className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]"
                      value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })}>
                      <option value="TEST">TEST (test.payu.in)</option>
                      <option value="PROD">PROD (secure.payu.in)</option>
                    </select>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={() => m.mutate()} disabled={m.isPending || !valid}>{m.isPending ? "Saving…" : "Save"}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </CardHeader>
      <CardContent>
        {restricted ? (
          <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">Visible to Super-Admins only.</div>
        ) : status?.configured ? (
          <div className="text-sm space-y-1">
            <div><span className="text-[color:var(--color-text-muted)]">Gateway:</span> <Badge variant="brand">{status.gateway}</Badge></div>
            <div><span className="text-[color:var(--color-text-muted)]">Main MID:</span> <span className="font-mono">{status.mid_code}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">Scheme:</span> <span className="font-mono">{status.scheme}</span> · <span className="text-[color:var(--color-text-muted)]">Env:</span> <Badge variant={status.env === "PROD" ? "danger" : "default"}>{status.env}</Badge></div>
            <div><span className="text-[color:var(--color-text-muted)]">Key:</span> <span className="font-mono">{status.key_hint}</span> <span className="text-[color:var(--color-text-muted)]">· salt sealed</span></div>
          </div>
        ) : (
          <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">
            No gateway credentials mapped yet. Orders won’t be signed for the gateway until Key + Salt are set.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TestCheckoutCard({ merchant }: { merchant: Merchant }) {
  const [amount, setAmount] = useState("100.00");
  const [email, setEmail] = useState("buyer@example.com");
  const [result, setResult] = useState<{ order?: { status?: string; txn_id?: string }; route?: { provider?: string }; charge?: { outcome?: string }; gateway?: { signed?: boolean } } | null>(null);

  const sim = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/merchants/${merchant.id}/test-pay`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, email, redirect: false }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d;
    },
    onSuccess: (d) => { setResult(d); toast.success(`Order ${d.order?.status ?? "ran"}`); },
    onError: (e: Error) => { setResult(null); toast.error("Failed", { description: e.message }); },
  });

  const payu = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/merchants/${merchant.id}/test-pay`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, email, redirect: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as { payu_url: string; fields: Record<string, string> };
    },
    onSuccess: (d) => {
      const f = document.createElement("form");
      f.method = "post"; f.action = d.payu_url;
      for (const [k, v] of Object.entries(d.fields)) {
        const i = document.createElement("input"); i.type = "hidden"; i.name = k; i.value = v; f.appendChild(i);
      }
      document.body.appendChild(f); f.submit();   // navigate the browser to PayU
    },
    onError: (e: Error) => toast.error("PayU redirect failed", { description: e.message }),
  });

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-base">Test checkout</CardTitle>
        <CardDescription>Run a payment for this merchant straight from the dashboard — no external checkout page needed.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label>Amount</Label><Input value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Customer email</Label><Input value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => sim.mutate()} disabled={sim.isPending}>
            {sim.isPending ? "Running…" : "Run simulated payment"}
          </Button>
          <Button onClick={() => payu.mutate()} disabled={payu.isPending}>
            <ArrowRight className="h-4 w-4" /> {payu.isPending ? "Redirecting…" : "Pay via PayU"}
          </Button>
        </div>
        {result && (
          <div className="rounded-md border p-3 text-sm space-y-1">
            <div><span className="text-[color:var(--color-text-muted)]">Result:</span> <Badge variant={result.order?.status === "SUCCESS" ? "success" : "danger"}>{result.order?.status ?? "—"}</Badge></div>
            <div><span className="text-[color:var(--color-text-muted)]">Txn:</span> <span className="font-mono text-xs">{result.order?.txn_id ?? "—"}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">Provider:</span> {result.route?.provider ?? "—"} · <span className="text-[color:var(--color-text-muted)]">charge:</span> {result.charge?.outcome ?? "—"} · <span className="text-[color:var(--color-text-muted)]">gateway signed:</span> {result.gateway?.signed ? "yes" : "no"}</div>
          </div>
        )}
        <p className="text-xs text-[color:var(--color-text-muted)]">“Simulated” runs Katana’s pipeline instantly (no PayU needed). “Pay via PayU” needs PayU creds set above and opens PayU’s hosted page.</p>
      </CardContent>
    </Card>
  );
}

export default function MerchantDetailView({ id }: { id: string }) {
  const merchantQ = useQuery({
    queryKey: ["merchant", id],
    queryFn: async () => {
      const all = (await fetch("/api/merchants").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { merchants: Merchant[] };
      return all.merchants.find((m) => m.id === id) ?? null;
    },
  });
  const subMidsQ = useQuery({
    queryKey: ["merchant", id, "sub-mids"],
    queryFn: async () => (await fetch("/api/sub-mids").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { sub_mids: SubMid[] },
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

      <ProviderAttributionCard merchantId={merchant.id} merchantCode={merchant.merchant_code} />

      <PayinOperationsCard merchantId={merchant.id} />

      <PaymentMethodsCard merchantId={merchant.id} />

      <PoolPayConfigCard merchantId={merchant.id} />

      <ApiKeysCard merchant={merchant} />

      <CheckoutKeyCard merchant={merchant} />

      <GatewayMidCard merchant={merchant} />

      <TestCheckoutCard merchant={merchant} />

      <Card>
        <CardHeader><CardTitle className="text-base">Sub-MIDs ({ownSubs.length})</CardTitle><CardDescription>MID surface configured for this merchant.</CardDescription></CardHeader>
        <CardContent>
          <DataTable columns={subCols} rows={ownSubs} loading={subMidsQ.isLoading} rowKey={(r) => r.id} emptyState="No Sub-MIDs yet. Create one at /sub-mids after CONFIG stage." />
        </CardContent>
      </Card>
    </>
  );
}
