"use client";

// Admin surface to configure a provider's PoolPay (Katana Pay) integration.
// Saving here cascades to every branch (merchant) mapped under the provider:
// their pay-ins sign/route with these credentials (see resolvePoolPayConfig).
//
// Secrets are write-only — the form shows whether one is saved, never its value.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug, KeyRound, ShieldCheck, Link2, Save, Webhook } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Integration {
  provider_id: string; vendor: string; enabled: boolean; env: "SANDBOX" | "PROD";
  base_url: string | null; pay_id: string | null; client_id: string | null;
  return_url: string | null; callback_url: string | null;
  secret_set: boolean; apikey_set: boolean; updated_by: string | null; updated_at: string | null;
}

export function IntegrationConfigCard({ providerId, canEdit }: { providerId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["provider-integration", providerId],
    queryFn: async () => (await fetch(`/api/providers/${providerId}/integrations`).then(async (r) => {
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || ("HTTP " + r.status));
      return d;
    })) as { integration: Integration },
  });

  const cfg = q.data?.integration;
  const [form, setForm] = useState({
    enabled: false, env: "SANDBOX" as "SANDBOX" | "PROD",
    base_url: "", pay_id: "", client_id: "", return_url: "", callback_url: "",
    secret: "", api_key: "",
  });

  // Hydrate the form once the config loads.
  useEffect(() => {
    if (!cfg) return;
    setForm((f) => ({
      ...f,
      enabled: cfg.enabled, env: cfg.env,
      base_url: cfg.base_url ?? "", pay_id: cfg.pay_id ?? "", client_id: cfg.client_id ?? "",
      return_url: cfg.return_url ?? "", callback_url: cfg.callback_url ?? "",
      secret: "", api_key: "",
    }));
  }, [cfg]);

  const save = useMutation({
    mutationFn: async () => {
      // Only send secret/api_key when the operator typed a new value.
      const body: Record<string, unknown> = {
        enabled: form.enabled, env: form.env,
        base_url: form.base_url || null, pay_id: form.pay_id || null, client_id: form.client_id || null,
        return_url: form.return_url || null, callback_url: form.callback_url || null,
      };
      if (form.secret) body.secret = form.secret;
      if (form.api_key) body.api_key = form.api_key;
      const r = await fetch(`/api/providers/${providerId}/integrations`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Save failed");
      return d;
    },
    onSuccess: () => {
      toast.success("Integration saved", { description: "Cascaded to all branches under this provider." });
      qc.invalidateQueries({ queryKey: ["provider-integration", providerId] });
      qc.invalidateQueries({ queryKey: ["poolpay-funnel", providerId] });
    },
    onError: (e: Error) => toast.error("Couldn’t save", { description: e.message }),
  });

  const set = (k: keyof typeof form) => (v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const live = form.enabled && form.env === "PROD";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base inline-flex items-center gap-2"><Plug className="h-4 w-4" /> Katana Pay (PoolPay) integration</CardTitle>
            <CardDescription>Configure once here — it auto-applies to every branch under this provider.</CardDescription>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant={cfg?.enabled ? "success" : "default"}>{cfg?.enabled ? "Enabled" : "Disabled"}</Badge>
            <Badge variant={cfg?.env === "PROD" ? "brand" : "info"}>{cfg?.env ?? "SANDBOX"}</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading ? (
          <div className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">Loading…</div>
        ) : (
          <>
            {/* Enable + environment */}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button" size="sm" variant={form.enabled ? "default" : "secondary"}
                disabled={!canEdit} onClick={() => set("enabled")(!form.enabled)}
              >
                <ShieldCheck className="h-4 w-4" /> {form.enabled ? "Integration ON" : "Integration OFF"}
              </Button>
              <div className="inline-flex overflow-hidden rounded-md border">
                {(["SANDBOX", "PROD"] as const).map((e) => (
                  <button
                    key={e} type="button" disabled={!canEdit}
                    onClick={() => set("env")(e)}
                    className={`px-3 py-1.5 text-xs font-semibold ${form.env === e ? "bg-[color:var(--color-brand)] text-white" : "bg-[color:var(--color-surface)] text-[color:var(--color-text-muted)]"}`}
                  >{e}</button>
                ))}
              </div>
              {live && <span className="text-xs text-[color:var(--color-warning)]">PROD needs a base URL + saved SECRET_KEY before it can go live.</span>}
            </div>

            {/* Endpoints + ids */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Base URL" icon={Link2}>
                <Input value={form.base_url} disabled={!canEdit} placeholder="https://core.pp-007.com"
                  onChange={(e) => set("base_url")(e.target.value)} />
              </Field>
              <Field label="PAY_ID">
                <Input value={form.pay_id} disabled={!canEdit} placeholder="1766566497559252"
                  onChange={(e) => set("pay_id")(e.target.value)} />
              </Field>
              <Field label="Return URL">
                <Input value={form.return_url} disabled={!canEdit} placeholder="https://yourbrand.com/response"
                  onChange={(e) => set("return_url")(e.target.value)} />
              </Field>
              <Field label="Callback URL" icon={Webhook}>
                <Input value={form.callback_url} disabled={!canEdit} placeholder="https://glhouse.shop/api/vendors/poolpay/callback"
                  onChange={(e) => set("callback_url")(e.target.value)} />
              </Field>
              <Field label="Client ID (optional)">
                <Input value={form.client_id} disabled={!canEdit} placeholder="x-client-id"
                  onChange={(e) => set("client_id")(e.target.value)} />
              </Field>
            </div>

            {/* Secrets — write only */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="SECRET_KEY (SHA256 hash)" icon={KeyRound} hint={cfg?.secret_set ? "A secret is saved — leave blank to keep it." : "Not set."}>
                <Input type="password" value={form.secret} disabled={!canEdit}
                  placeholder={cfg?.secret_set ? "•••••••• (unchanged)" : "paste SECRET_KEY"}
                  onChange={(e) => set("secret")(e.target.value)} />
              </Field>
              <Field label="API key / Bearer (optional)" icon={KeyRound} hint={cfg?.apikey_set ? "Saved — leave blank to keep." : "Not set."}>
                <Input type="password" value={form.api_key} disabled={!canEdit}
                  placeholder={cfg?.apikey_set ? "•••••••• (unchanged)" : "paste API key"}
                  onChange={(e) => set("api_key")(e.target.value)} />
              </Field>
            </div>

            {canEdit && (
              <div className="flex items-center justify-between gap-3 pt-1">
                <span className="text-xs text-[color:var(--color-text-muted)]">
                  {cfg?.updated_at ? `Last updated ${new Date(cfg.updated_at).toLocaleString()}${cfg.updated_by ? ` by ${cfg.updated_by}` : ""}` : "Not configured yet."}
                </span>
                <Button onClick={() => save.mutate()} disabled={save.isPending}>
                  <Save className="h-4 w-4" /> {save.isPending ? "Saving…" : "Save & cascade"}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, hint, icon: Icon, children }: { label: string; hint?: string; icon?: typeof Plug; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="inline-flex items-center gap-1.5 text-xs">{Icon && <Icon className="h-3.5 w-3.5" />}{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-[color:var(--color-text-subtle)]">{hint}</p>}
    </div>
  );
}
