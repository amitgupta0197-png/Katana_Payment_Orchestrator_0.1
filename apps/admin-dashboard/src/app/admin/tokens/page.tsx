"use client";

// L1 — vault. Tabbed (Payment tokens / Credential vault) with inline Issue
// dialog for sandbox tokens.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldCheck, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataView } from "@/components/world-class/data-view";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Token {
  token_id: string; customer_ref: string; merchant_id: string; provider: string;
  method: string; brand: string | null; last4: string | null;
  exp_month: number | null; exp_year: number | null; status: string;
  created_at: string; last_used_at: string | null; has_network_token: boolean;
}
interface Credential {
  credential_id: string; kind: string; owner_type: string; owner_id: string;
  label: string; key_version: number; created_at: string;
  rotated_at: string | null; rotated_by: string;
}

function IssueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    customer: "cust-demo-001", provider: "RAZORPAY",
    providerToken: `pgt_demo_${Math.random().toString(36).slice(2, 10)}`,
    brand: "VISA", last4: "4242",
    method: "CARD" as "CARD" | "UPI" | "WALLET",
  });
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/tokens", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_ref: form.customer, provider: form.provider, provider_token: form.providerToken,
          method: form.method, brand: form.brand, last4: form.last4, exp_month: 12, exp_year: 2030,
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body as { token_id: string };
    },
    onSuccess: (b) => { toast.success(`Token issued: ${b.token_id.slice(0, 8)}`); qc.invalidateQueries({ queryKey: ["tokens"] }); onOpenChange(false); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Issue sandbox token</DialogTitle>
          <DialogDescription>The raw provider token is hashed before persistence — only the sha256 lives in the vault.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div><Label>Customer ref</Label><Input value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} /></div>
          <div><Label>Provider</Label><Input value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} /></div>
          <div><Label>Method</Label>
            <select className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value as typeof form.method })}>
              <option value="CARD">CARD</option><option value="UPI">UPI</option><option value="WALLET">WALLET</option>
            </select>
          </div>
          <div><Label>Brand</Label><Input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} /></div>
          <div><Label>Last 4</Label><Input value={form.last4} onChange={(e) => setForm({ ...form, last4: e.target.value })} /></div>
          <div className="col-span-1 sm:col-span-3"><Label>Provider token</Label><Input value={form.providerToken} onChange={(e) => setForm({ ...form, providerToken: e.target.value })} /></div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Issuing…" : "Issue token"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TokensPage() {
  const [issueOpen, setIssueOpen] = useState(false);
  const tQ = useQuery({
    queryKey: ["tokens"],
    queryFn: async () => (await fetch("/api/tokens").then((r) => r.json())) as { tokens: Token[] },
    refetchInterval: 8000,
  });
  const cQ = useQuery({
    queryKey: ["credentials"],
    queryFn: async () => (await fetch("/api/admin/credentials").then((r) => r.json())) as { credentials: Credential[] },
    refetchInterval: 15000,
  });
  const tokens = tQ.data?.tokens ?? [];
  const creds = cQ.data?.credentials ?? [];

  const tokenCols: Column<Token>[] = [
    { key: "token_id", header: "Token", render: (r) => <span className="font-mono text-xs">{r.token_id.slice(0, 8)}</span> },
    { key: "customer_ref", header: "Customer", render: (r) => <span className="font-mono text-xs">{r.customer_ref}</span> },
    { key: "merchant_id", header: "Branch" },
    { key: "provider", header: "Provider", render: (r) => <Badge variant="brand">{r.provider}</Badge> },
    { key: "method", header: "Method" },
    { key: "brand", header: "Brand", render: (r) => r.brand ?? "—" },
    { key: "last4", header: "Last4", render: (r) => r.last4 ? `••${r.last4}` : "—" },
    { key: "exp_month", header: "Exp", render: (r) => r.exp_month && r.exp_year ? `${String(r.exp_month).padStart(2, "0")}/${r.exp_year}` : "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "has_network_token", header: "Net token", render: (r) => r.has_network_token ? <Badge variant="success">yes</Badge> : "—" },
    { key: "created_at", header: "Created", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
  ];
  const credCols: Column<Credential>[] = [
    { key: "kind", header: "Kind", render: (r) => <Badge variant="brand">{r.kind}</Badge> },
    { key: "owner_id", header: "Owner", render: (r) => <span className="font-mono text-xs">{r.owner_type}/{r.owner_id}</span> },
    { key: "label", header: "Label" },
    { key: "key_version", header: "v", render: (r) => <span className="tabular-nums">{r.key_version}</span> },
    { key: "created_at", header: "Created", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
    { key: "rotated_at", header: "Rotated", render: (r) => r.rotated_at ? <span className="text-xs">{formatDateTime(r.rotated_at)}</span> : "—" },
    { key: "rotated_by", header: "By", render: (r) => r.rotated_by || "—" },
  ];

  return (
    <>
      <PageHeader
        title="Vault"
        description="Payment-method tokens + credential vault (AES-256-GCM). Plaintext never leaves the server."
        icon={ShieldCheck}
      />
      <Tabs defaultValue="tokens">
        <TabsList>
          <TabsTrigger value="tokens"><KeyRound className="h-3.5 w-3.5" /> Payment tokens
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{tokens.length}</span>
          </TabsTrigger>
          <TabsTrigger value="creds"><ShieldCheck className="h-3.5 w-3.5" /> Credential vault
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{creds.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tokens">
          <DataView rows={tokens} columns={tokenCols} rowKey={(r) => r.token_id} loading={tQ.isLoading}
            search={{ placeholder: "Search by customer / branch / brand / last4…", fields: ["customer_ref", "merchant_id", "provider", "brand", "last4"] }}
            filters={[
              { key: "active",  label: "Active",  predicate: (r: Token) => r.status === "ACTIVE" },
              { key: "revoked", label: "Revoked", predicate: (r: Token) => r.status === "REVOKED" },
              { key: "card",    label: "CARD",    predicate: (r: Token) => r.method === "CARD" },
              { key: "upi",     label: "UPI",     predicate: (r: Token) => r.method === "UPI" },
              { key: "network", label: "Network token", predicate: (r: Token) => r.has_network_token },
            ]}
            fab={{ label: "Issue token", icon: Plus, onClick: () => setIssueOpen(true) }}
            savedViewKey="vault-tokens" refresh={() => tQ.refetch()}
            emptyTitle="No tokens yet" />
        </TabsContent>
        <TabsContent value="creds">
          <DataView rows={creds} columns={credCols} rowKey={(r) => r.credential_id} loading={cQ.isLoading}
            search={{ placeholder: "Search by kind / owner / label…", fields: ["kind", "owner_id", "label"] }}
            savedViewKey="vault-creds"
            emptyTitle="Vault is empty"
            emptyDescription="Use POST /api/admin/credentials to store; the helper round-trips on write." />
        </TabsContent>
      </Tabs>
      <IssueDialog open={issueOpen} onOpenChange={setIssueOpen} />
    </>
  );
}
