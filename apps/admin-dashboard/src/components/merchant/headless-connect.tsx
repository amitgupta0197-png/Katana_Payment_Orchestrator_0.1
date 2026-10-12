"use client";

// Quasi-headless setup for one banker (P2P method HEADLESS, lib/headless): its own PhonePe and
// Paytm PG accounts saved for P2P. The customer picks one of them on Katana's hosted checkout.
// Staff only (Super Admin): it names the PSPs and their accounts. Saving goes through the usual
// gateway route (POST …/gateway-mid) with channel P2P: an account already saved for that PSP is
// rotated, otherwise it takes the banker's first account when free, else a new one beside it.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Copy, MonitorSmartphone } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GatewayCredentialsDialog, type GatewayForm } from "@/components/merchant/gateway-credentials-dialog";
import { GatewayLogo } from "@/components/merchant/gateway-logo";
import { HEADLESS_PSP_INFO, HEADLESS_PSPS, type HeadlessPsp } from "@/lib/headless";

interface State {
  banker: string;
  accounts: { psp: HeadlessPsp; vault_label: string; account: "main" | "extra"; env: string; golive: string | null }[];
  live_psps: HeadlessPsp[];
  main_used: boolean;
  switched_on: Record<HeadlessPsp, boolean>;
  webhook_urls: Record<HeadlessPsp, string>;
}
const muted = "text-[color:var(--color-text-muted)]";

export function HeadlessConnectCard({ merchantId, merchantCode }: { merchantId: string; merchantCode: string }) {
  const qc = useQueryClient();
  const key = ["merchant", merchantId, "headless"];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => { const r = await fetch(`/api/merchants/${merchantId}/headless`); if (!r.ok) throw new Error("HTTP " + r.status); return r.json() as Promise<State>; },
  });
  const save = useMutation({
    mutationFn: async (form: GatewayForm & { account?: string }) => {
      const r = await fetch(`/api/merchants/${merchantId}/gateway-mid`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d;
    },
    onSuccess: () => {
      toast.success("Saved for quasi-headless");
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["merchant", merchantId] });
    },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });
  if (q.isLoading || q.error || !q.data) return null;
  const s = q.data;
  const accountFor = (psp: HeadlessPsp) => s.accounts.find((a) => a.psp === psp);
  const target = (psp: HeadlessPsp) => accountFor(psp)?.vault_label ?? (s.main_used ? "new" : undefined);
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast.success("Copied"), () => toast.error("Couldn't copy"));

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><MonitorSmartphone className="h-4 w-4" /> Quasi-headless checkout</CardTitle>
        <CardDescription>
          The merchant&apos;s app opens Katana&apos;s checkout in a WebView. The customer picks PhonePe or Paytm and pays in that app,
          through this banker&apos;s own PG account. Connect one or both.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {HEADLESS_PSPS.map((psp) => {
            const a = accountFor(psp);
            const live = s.live_psps.includes(psp);
            return (
              <div key={psp} className="rounded-xl border p-3">
                <div className="flex items-center gap-2">
                  <GatewayLogo id={psp} size={24} />
                  <span className="font-medium">{HEADLESS_PSP_INFO[psp].app}</span>
                  <Badge className="ml-auto" variant={live ? (a?.golive === "VERIFYING" ? "warning" : "success") : a ? "info" : "default"}>
                    {live ? (a?.golive === "VERIFYING" ? "Live, verifying" : "Live") : a ? (a.env === "PROD" ? "Saved, not usable" : "Test account") : "Not connected"}
                  </Badge>
                </div>
                <p className={`mt-1 text-xs ${muted}`}>
                  {a ? `${a.account === "main" ? "First account" : "Extra account"} · ${a.env === "PROD" ? "live" : "test"}` : "Offered on the checkout once saved live for P2P."}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <GatewayCredentialsDialog kind="payin" merchantCode={merchantCode} configured={!!a} current={psp} only={[psp]}
                    fixed={{ channel: "P2P" }} trigger={a ? "Change" : `Connect ${HEADLESS_PSP_INFO[psp].app}`}
                    saving={save.isPending} onSave={(f) => save.mutateAsync({ ...f, account: target(psp) })} />
                  <Button size="sm" variant="ghost" onClick={() => copy(s.webhook_urls[psp])}><Copy className="h-3.5 w-3.5" /> Webhook URL</Button>
                </div>
                {a?.env === "PROD" && !s.switched_on[psp] && (
                  <p className="mt-2 flex gap-1.5 text-xs text-[color:var(--color-warning)]">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Live {HEADLESS_PSP_INFO[psp].app} is not switched on on the server ({psp} in PAYIN_CONNECTORS_PROD).
                  </p>
                )}
              </div>
            );
          })}
        </div>
        <p className={`text-xs ${muted}`}>
          Orders from the P2P API answer a <code>checkout_url</code>. The merchant opens it in its app&apos;s WebView: integration guide
          {" "}<a className="text-[color:var(--color-brand)] hover:underline" href="/katana-headless-checkout.html" target="_blank" rel="noreferrer">Quasi-headless checkout</a>.
        </p>
      </CardContent>
    </Card>
  );
}
