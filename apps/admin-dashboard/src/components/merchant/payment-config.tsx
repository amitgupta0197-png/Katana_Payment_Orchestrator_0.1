"use client";

// Per-merchant payment config cards for the merchant window:
//   - PaymentMethodsCard: toggle which collection methods the merchant may use
//   - PoolPayConfigCard:  PoolPay (PG pay-in) settings for the merchant
// Both read/write /api/merchants/[id]/payment-config and share a query cache.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { CreditCard, Wallet, Smartphone, QrCode, Landmark, Coins, Check } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

interface PoolPay { enabled?: boolean; pay_id?: string; settlement_vpa?: string; env?: string; notes?: string }
interface Config { methods: string[]; enabled_methods: string[]; poolpay: PoolPay; blocked?: boolean }

const MUTED = "text-[color:var(--color-text-muted)]";
const METHOD_META: Record<string, { label: string; Icon: LucideIcon }> = {
  UPI_INTENT: { label: "UPI Intent", Icon: Smartphone },
  UPI_COLLECT: { label: "UPI Collect", Icon: Smartphone },
  CARD: { label: "Cards", Icon: CreditCard },
  NETBANKING: { label: "Netbanking", Icon: Landmark },
  WALLET: { label: "Wallets", Icon: Wallet },
  QR: { label: "QR", Icon: QrCode },
  CRYPTO: { label: "Crypto", Icon: Coins },
};

function useConfig(merchantId: string) {
  return useQuery({
    queryKey: ["merchant", merchantId, "payment-config"],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/payment-config`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as Config;
    },
  });
}

export function PaymentMethodsCard({ merchantId }: { merchantId: string }) {
  const qc = useQueryClient();
  const q = useConfig(merchantId);
  const methods = q.data?.methods ?? [];
  const enabled = new Set(q.data?.enabled_methods ?? []);
  const blocked = q.data?.blocked === true;

  const patch = async (body: Record<string, unknown>) => {
    const r = await fetch(`/api/merchants/${merchantId}/payment-config`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
    return (await r.json()) as Config;
  };

  const m = useMutation({
    mutationFn: (next: string[]) => patch({ enabled_methods: next }),
    onSuccess: (d) => { qc.setQueryData(["merchant", merchantId, "payment-config"], d); },
    onError: (e: Error) => { toast.error("Failed", { description: e.message }); qc.invalidateQueries({ queryKey: ["merchant", merchantId, "payment-config"] }); },
  });

  const block = useMutation({
    mutationFn: (next: boolean) => patch({ blocked: next }),
    onSuccess: (d) => { toast[d.blocked ? "error" : "success"](d.blocked ? "Branch blocked — new pay-ins rejected" : "Branch unblocked"); qc.setQueryData(["merchant", merchantId, "payment-config"], d); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const toggle = (method: string) => {
    const next = enabled.has(method) ? [...enabled].filter((x) => x !== method) : [...enabled, method];
    m.mutate(next);
  };

  return (
    <Card className="mb-4">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Payment collection methods</CardTitle>
          <CardDescription>Which methods this branch can collect payments through. Tap to toggle.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {blocked && <Badge variant="danger">BLOCKED</Badge>}
          <Button size="sm" variant={blocked ? "secondary" : "danger"} disabled={block.isPending} onClick={() => block.mutate(!blocked)}>
            {blocked ? "Unblock merchant" : "Block merchant"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className={`text-sm ${MUTED}`}>Loading…</div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {methods.map((mk) => {
              const meta = METHOD_META[mk] ?? { label: mk, Icon: CreditCard };
              const on = enabled.has(mk);
              const Icon = meta.Icon;
              return (
                <button
                  key={mk}
                  onClick={() => toggle(mk)}
                  disabled={m.isPending}
                  aria-pressed={on}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition disabled:opacity-60 ${
                    on
                      ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]"
                      : `border-[color:var(--color-border)] ${MUTED} hover:bg-[color:var(--color-surface-muted)]`
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1 truncate text-left">{meta.label}</span>
                  {on && <Check className="h-3.5 w-3.5 shrink-0" />}
                </button>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function PoolPayConfigCard({ merchantId }: { merchantId: string }) {
  const qc = useQueryClient();
  const q = useConfig(merchantId);
  const [form, setForm] = useState({ enabled: false, pay_id: "", settlement_vpa: "", env: "SANDBOX", notes: "" });

  // Hydrate the form once config loads.
  useEffect(() => {
    const pp = q.data?.poolpay;
    if (pp) setForm({
      enabled: !!pp.enabled, pay_id: pp.pay_id ?? "", settlement_vpa: pp.settlement_vpa ?? "",
      env: pp.env ?? "SANDBOX", notes: pp.notes ?? "",
    });
  }, [q.data]);

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/payment-config`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolpay: form }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as Config;
    },
    onSuccess: (d) => { toast.success("Katana Pay configuration saved"); qc.setQueryData(["merchant", merchantId, "payment-config"], d); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  return (
    <Card className="mb-4">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Katana Pay configuration</CardTitle>
          <CardDescription>PG pay-in (UPI) settings for this branch.</CardDescription>
        </div>
        <Badge variant={form.enabled ? "success" : "default"}>{form.enabled ? "enabled" : "disabled"}</Badge>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          Enable Katana Pay collection for this branch
        </label>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Katana Pay ID</Label>
            <Input value={form.pay_id} onChange={(e) => setForm({ ...form, pay_id: e.target.value })} placeholder="pay_…" />
          </div>
          <div className="space-y-1.5">
            <Label>Settlement VPA</Label>
            <Input value={form.settlement_vpa} onChange={(e) => setForm({ ...form, settlement_vpa: e.target.value })} placeholder="branch@upi" />
          </div>
          <div className="space-y-1.5">
            <Label>Environment</Label>
            <select
              className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]"
              value={form.env}
              onChange={(e) => setForm({ ...form, env: e.target.value })}
            >
              <option value="SANDBOX">SANDBOX</option>
              <option value="PROD">PROD</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Notes <span className={`font-normal ${MUTED}`}>(optional)</span></Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Saving…" : "Save Katana Pay config"}</Button>
        </div>
      </CardContent>
    </Card>
  );
}
