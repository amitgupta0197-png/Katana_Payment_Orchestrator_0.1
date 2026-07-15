"use client";

// Pine Labs (Plural) API key configuration — rendered on both the admin branch page
// (endpoint=/api/merchants/{id}/pinelabs) and the merchant portal (endpoint=/api/me/
// pinelabs). Lets an admin or the merchant paste their Pine Labs client id + secret so
// Katana can pull that merchant's transactions + RRN. Secret is write-only: we show
// whether one is saved, never its value.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Cfg {
  enabled: boolean; env: "SANDBOX" | "PROD"; client_id: string;
  pinelabs_merchant_id: string; secret_set: boolean;
  updated_by: string; updated_at: string | null;
}

export function PinelabsConfigCard({ endpoint, canEdit }: { endpoint: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["pinelabs", endpoint],
    queryFn: async () => {
      const r = await fetch(endpoint);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as Cfg;
    },
  });

  const [form, setForm] = useState({
    enabled: false, env: "PROD" as "SANDBOX" | "PROD",
    client_id: "", pinelabs_merchant_id: "", client_secret: "",
  });
  useEffect(() => {
    if (q.data) setForm((f) => ({
      ...f, enabled: q.data.enabled, env: q.data.env,
      client_id: q.data.client_id, pinelabs_merchant_id: q.data.pinelabs_merchant_id,
      client_secret: "",
    }));
  }, [q.data]);

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        enabled: form.enabled, env: form.env,
        client_id: form.client_id, pinelabs_merchant_id: form.pinelabs_merchant_id,
      };
      if (form.client_secret.trim()) body.client_secret = form.client_secret.trim();
      const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Save failed");
      return d;
    },
    onSuccess: () => { toast.success("Pine Labs settings saved"); setForm((f) => ({ ...f, client_secret: "" })); qc.invalidateQueries({ queryKey: ["pinelabs", endpoint] }); },
    onError: (e: Error) => toast.error("Save failed", { description: e.message }),
  });

  const secretSet = q.data?.secret_set;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" /> Pine Labs API keys</CardTitle>
            <CardDescription>Connect this branch&apos;s Pine Labs (Plural) account so Katana can pull its transactions &amp; RRN.</CardDescription>
          </div>
          <Badge variant={q.data?.enabled ? "success" : "default"}>{q.data?.enabled ? "Enabled" : "Off"}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Environment</Label>
            <select
              className="w-full rounded-md border border-[color:var(--color-border-strong)] bg-[color:var(--color-surface)] px-3 py-2 text-sm"
              value={form.env} disabled={!canEdit}
              onChange={(e) => setForm({ ...form, env: e.target.value as "SANDBOX" | "PROD" })}
            >
              <option value="PROD">Production (api.pluralpay.in)</option>
              <option value="SANDBOX">Sandbox (test keys)</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Enabled</Label>
            <label className="flex h-10 items-center gap-2 text-sm">
              <input type="checkbox" checked={form.enabled} disabled={!canEdit}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                className="h-4 w-4 accent-[color:var(--color-brand)]" />
              Pull transactions from Pine Labs
            </label>
          </div>
          <div className="space-y-1.5">
            <Label>Client ID</Label>
            <Input value={form.client_id} disabled={!canEdit} placeholder="Pine Labs / Plural client id"
              onChange={(e) => setForm({ ...form, client_id: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Pine Labs Merchant ID <span className="text-[color:var(--color-text-subtle)]">(optional)</span></Label>
            <Input value={form.pinelabs_merchant_id} disabled={!canEdit} placeholder="merchant id on Pine Labs"
              onChange={(e) => setForm({ ...form, pinelabs_merchant_id: e.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="flex items-center gap-1.5">Client Secret {secretSet && <span className="inline-flex items-center gap-1 text-xs text-[color:var(--color-success)]"><ShieldCheck className="h-3.5 w-3.5" /> saved</span>}</Label>
            <Input type="password" value={form.client_secret} disabled={!canEdit}
              placeholder={secretSet ? "•••••••••• (leave blank to keep)" : "paste Pine Labs client secret"}
              onChange={(e) => setForm({ ...form, client_secret: e.target.value })} />
            <p className="text-xs text-[color:var(--color-text-subtle)]">Encrypted at rest. Never shown again after saving.</p>
          </div>
        </div>
        {canEdit && (
          <div className="flex items-center gap-3">
            <Button onClick={() => save.mutate()} disabled={save.isPending}><Save className="h-4 w-4" /> {save.isPending ? "Saving…" : "Save"}</Button>
            {q.data?.updated_at && <span className="text-xs text-[color:var(--color-text-subtle)]">last updated by {q.data.updated_by || "—"}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
