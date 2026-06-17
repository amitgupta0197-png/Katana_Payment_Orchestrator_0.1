"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

function TokenCreator() {
  const qc = useQueryClient();
  const [customer, setCustomer] = useState("cust-demo-001");
  const [provider, setProvider] = useState("RAZORPAY");
  const [providerToken, setProviderToken] = useState(`pgt_demo_${Math.random().toString(36).slice(2, 10)}`);
  const [brand, setBrand] = useState("VISA");
  const [last4, setLast4] = useState("4242");
  const [method, setMethod] = useState<"CARD"|"UPI"|"WALLET">("CARD");

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/tokens", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_ref: customer, provider, provider_token: providerToken,
          method, brand, last4, exp_month: 12, exp_year: 2030,
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: (b) => { toast.success(`Token issued: ${b.token_id.slice(0, 8)}`); qc.invalidateQueries({ queryKey: ["tokens"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Issue a sandbox token</CardTitle><CardDescription>The raw provider token is hashed before persistence — only the sha256 lives in the vault.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div><Label>Customer ref</Label><Input value={customer} onChange={(e) => setCustomer(e.target.value)} /></div>
          <div><Label>Provider</Label><Input value={provider} onChange={(e) => setProvider(e.target.value)} /></div>
          <div><Label>Method</Label>
            <select className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]" value={method} onChange={(e) => setMethod(e.target.value as any)}>
              <option value="CARD">CARD</option>
              <option value="UPI">UPI</option>
              <option value="WALLET">WALLET</option>
            </select>
          </div>
          <div><Label>Brand</Label><Input value={brand} onChange={(e) => setBrand(e.target.value)} /></div>
          <div><Label>Last 4</Label><Input value={last4} onChange={(e) => setLast4(e.target.value)} /></div>
          <div className="col-span-1 sm:col-span-3"><Label>Provider token</Label><Input value={providerToken} onChange={(e) => setProviderToken(e.target.value)} /></div>
        </div>
        <Button onClick={() => m.mutate()} disabled={m.isPending}><KeyRound className="h-4 w-4" /> Issue token</Button>
      </CardContent>
    </Card>
  );
}

export default function TokensPage() {
  const tQ = useQuery({
    queryKey: ["tokens"],
    queryFn: async () => (await fetch("/api/tokens").then((r) => r.json())) as { tokens: Token[] },
    refetchInterval: 6000,
  });
  const cQ = useQuery({
    queryKey: ["credentials"],
    queryFn: async () => (await fetch("/api/admin/credentials").then((r) => r.json())) as { credentials: Credential[] },
    refetchInterval: 10000,
  });

  const tokenCols: Column<Token>[] = [
    { key: "token_id", header: "Token", render: (r) => <span className="font-mono text-xs">{r.token_id.slice(0, 8)}</span> },
    { key: "customer_ref", header: "Customer", render: (r) => <span className="font-mono text-xs">{r.customer_ref}</span> },
    { key: "merchant_id", header: "Merchant" },
    { key: "provider", header: "Provider", render: (r) => <Badge variant="brand">{r.provider}</Badge> },
    { key: "method", header: "Method" },
    { key: "brand", header: "Brand", render: (r) => r.brand ?? "—" },
    { key: "last4", header: "Last4", render: (r) => r.last4 ? `••${r.last4}` : "—" },
    { key: "exp_month", header: "Exp", render: (r) => r.exp_month && r.exp_year ? `${String(r.exp_month).padStart(2,"0")}/${r.exp_year}` : "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "has_network_token", header: "Net token", render: (r) => r.has_network_token ? <Badge variant="success">yes</Badge> : "—" },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];
  const credCols: Column<Credential>[] = [
    { key: "kind", header: "Kind", render: (r) => <Badge variant="brand">{r.kind}</Badge> },
    { key: "owner_id", header: "Owner", render: (r) => <span className="font-mono text-xs">{r.owner_type}/{r.owner_id}</span> },
    { key: "label", header: "Label" },
    { key: "key_version", header: "v" },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
    { key: "rotated_at", header: "Rotated", render: (r) => r.rotated_at ? formatDateTime(r.rotated_at) : "—" },
    { key: "rotated_by", header: "By", render: (r) => r.rotated_by || "—" },
  ];

  return (
    <>
      <PageHeader
        title="Vault"
        description="Payment-method tokens + credential vault (AES-256-GCM). Plaintext never leaves the server."
        icon={ShieldCheck}
      />
      <div className="mb-4"><TokenCreator /></div>
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Payment tokens ({(tQ.data?.tokens ?? []).length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={tokenCols} rows={tQ.data?.tokens ?? []} rowKey={(r) => r.token_id} emptyState="No tokens yet." loading={tQ.isLoading} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Credential vault ({(cQ.data?.credentials ?? []).length})</CardTitle><CardDescription>Only metadata is shown. Use POST /api/admin/credentials to store; the helper round-trips on write.</CardDescription></CardHeader>
        <CardContent><DataTable columns={credCols} rows={cQ.data?.credentials ?? []} rowKey={(r) => r.credential_id} emptyState="Vault is empty." loading={cQ.isLoading} /></CardContent>
      </Card>
    </>
  );
}
