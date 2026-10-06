"use client";

// Live test (banker page → Intent, and → P2P). Katana staff make a real, live payment on the
// banker, get its payment link, pay it from a phone and watch it be confirmed: on Intent by the
// banker's gateway; on P2P by its P2P processor account (e.g. PayAtom on P2P) if it has one, else
// paid to its own UPI ID and confirmed by the bank credit. Below it, that flow's gateway accounts
// on the go-live checklist, which a paid test completes.
// STAFF ONLY: it names the gateway. Route: /api/merchants/{id}/intent-test (both flows).

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { Copy, ExternalLink, FlaskConical, RefreshCw, Rocket } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GoLiveAccountCard, type GoLiveAccount } from "@/components/gateway/golive-account";
import { useAccess } from "@/lib/use-access";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface LiveTest {
  id: string; order_id: string; amount: number; status: string; rrn: string; created_at: string;
  by: string | null; gateway: string | null; account: string | null; pay_link: string; terminal: boolean;
  channel_type: string | null;
}

const MUTED = "text-[color:var(--color-text-muted)]";
const PAID = new Set(["SUCCESS", "SUCCEEDED"]);

export function IntentLiveTestCard({ merchantId, merchantCode, flow = "INTENT" }: { merchantId: string; merchantCode: string; flow?: "INTENT" | "P2P" }) {
  const p2p = flow === "P2P";
  const qc = useQueryClient();
  const persona = useAccess().data?.persona;
  const canCreate = persona === "SUPER_ADMIN" || persona === "ADMIN";
  const [amount, setAmount] = useState("1");
  const [phone, setPhone] = useState("");
  const [shownId, setShownId] = useState<string | null>(null);

  const tests = useQuery({
    queryKey: ["merchant", merchantId, "intent-test"],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/intent-test`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { tests: LiveTest[]; limits: { max_amount: number; max_orders: number } };
    },
    // Follow an open test until the gateway settles it.
    refetchInterval: (q) => ((q.state.data as { tests?: LiveTest[] } | undefined)?.tests ?? []).some((t) => !t.terminal) ? 5_000 : false,
  });

  const golive = useQuery({
    queryKey: ["ops:gateway-golive", merchantCode],
    queryFn: async () => {
      const r = await fetch(`/api/ops/gateway-golive?merchant=${encodeURIComponent(merchantCode)}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { accounts: GoLiveAccount[] };
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/intent-test`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, customer_phone: phone.trim() || undefined, flow }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? d.message ?? "HTTP " + r.status);
      return d as { order: { id: string }; account: string | null; warning: string | null };
    },
    onSuccess: (d) => {
      setShownId(d.order.id);
      if (d.warning) toast.warning("Created, but not on the gateway", { description: d.warning, duration: 15000 });
      else toast.success("Payment link ready", { description: d.account ? `On account ${d.account}` : undefined });
      qc.invalidateQueries({ queryKey: ["merchant", merchantId, "intent-test"] });
      qc.invalidateQueries({ queryKey: ["merchant", merchantId, "payin-orders"] });
    },
    onError: (e: Error) => toast.error("Not created", { description: e.message, duration: 12000 }),
  });

  // Ask the gateway now instead of waiting for its webhook or the sweep.
  const check = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/vendors/katana/order/${id}/refresh`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { status: string; changed: boolean; note?: string };
    },
    onSuccess: (d) => {
      toast[d.changed ? "success" : "info"](`Status: ${d.status}`, d.note ? { description: d.note, duration: 12000 } : undefined);
      qc.invalidateQueries({ queryKey: ["merchant", merchantId, "intent-test"] });
    },
    onError: (e: Error) => toast.error("Check failed", { description: e.message }),
  });

  // Each tab shows its own flow's tests.
  const list = (tests.data?.tests ?? []).filter((t) => (t.channel_type ?? "INTENT") === flow);
  const shown = list.find((t) => t.id === shownId) ?? list.find((t) => !t.terminal) ?? null;
  const accounts = (golive.data?.accounts ?? []).filter((a) => (a.channel ?? "INTENT") === flow);
  const verifying = accounts.some((a) => a.status === "VERIFYING");
  const lim = tests.data?.limits;
  // This flow's account decides the limits: the gateway's own live minimum (RubyVault: ₹500) and
  // the verifying cap, which is never below it.
  const acct = accounts.find((a) => a.status === "VERIFYING") ?? accounts[0];
  const minAmount = acct?.min_amount ?? null;
  const maxAmount = acct?.verify_max_amount ?? lim?.max_amount;
  // Start the amount at the gateway's minimum, unless someone already typed one.
  useEffect(() => { if (minAmount && amount === "1") setAmount(String(minAmount)); }, [minAmount]); // eslint-disable-line react-hooks/exhaustive-deps
  const copy = (s: string) => { navigator.clipboard?.writeText(s); toast.success("Link copied"); };

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><FlaskConical className="h-4 w-4" /> {p2p ? "P2P live test" : "Intent live test"}{p2p ? <InfoTip label="the P2P live test">A real payment you make yourself to this banker&apos;s UPI ID. It proves money arrives. The banker&apos;s server gets no message for it.</InfoTip> : <InfoTip label="the Intent live test">A real payment you make yourself through the gateway. It proves the gateway takes money and tells Katana. The banker&apos;s server gets no message for it.</InfoTip>}</CardTitle>
        <CardDescription>
          {p2p
            ? <>A real P2P payment on this banker: through its P2P processor account if it has one, otherwise to its own UPI ID
                (confirmed by the bank credit). Create a link, open it on a phone and pay.</>
            : <>A real payment through this banker&apos;s pay-in gateway. Create a link, open it on a phone and pay; the gateway
                confirms it here.</>}
          {" "}The banker&apos;s server is not sent a callback for it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {verifying && lim && maxAmount != null && (
          <div className="rounded-md border border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning-muted)] px-3 py-2 text-sm">
            The account is verifying: each payment can be at most {formatAmount(maxAmount, "INR")}, {lim.max_orders} in all, until it is set live below.
            {minAmount ? <> This gateway takes at least {formatAmount(minAmount, "INR")} per payment.</> : null}
          </div>
        )}
        {!verifying && minAmount ? (
          <p className={`text-xs ${MUTED}`}>This gateway takes at least {formatAmount(minAmount, "INR")} per payment.</p>
        ) : null}

        {canCreate ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-32 space-y-1.5">
              <Label htmlFor="lt-amount">Amount (₹)</Label>
              <Input id="lt-amount" type="number" min="1" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="w-48 space-y-1.5">
              <Label htmlFor="lt-phone">Payer phone <span className={`font-normal ${MUTED}`}>(optional)</span></Label>
              <Input id="lt-phone" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="9XXXXXXXXX" />
            </div>
            <Button onClick={() => create.mutate()} disabled={create.isPending || !(Number(amount) >= (minAmount ?? 1))}
              title={minAmount && Number(amount) < minAmount ? `At least ₹${minAmount} on this gateway` : undefined}>
              <ExternalLink className="h-4 w-4" /> {create.isPending ? "Creating…" : "Create payment link"}
            </Button>
          </div>
        ) : (
          <p className={`text-sm ${MUTED}`}>Only a Super Admin or Admin can create a live test.</p>
        )}

        {shown && (
          <div className="flex flex-wrap gap-4 rounded-lg border p-3">
            <div className="rounded-md bg-white p-2"><QRCodeSVG value={shown.pay_link} size={128} level="M" /></div>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{shown.order_id}</span>
                <span className="text-sm font-medium">{formatAmount(shown.amount, "INR")}</span>
                <Badge variant={statusVariant(shown.status)}>{shown.status}</Badge>
                {!shown.terminal && <span className={`text-xs ${MUTED}`}>waiting for the gateway…</span>}
              </div>
              <div className="flex items-center gap-1 rounded-md border px-2 py-1">
                <code className="min-w-0 flex-1 truncate text-xs">{shown.pay_link}</code>
                <Button size="sm" variant="ghost" title="Copy link" onClick={() => copy(shown.pay_link)}><Copy className="h-4 w-4" /></Button>
                <Button asChild size="sm" variant="ghost" title="Open"><a href={shown.pay_link} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4" /></a></Button>
              </div>
              <p className={`text-xs ${MUTED}`}>
                Scan the code or send the link to the phone that will pay.
                {shown.gateway ? ` Gateway: ${shown.gateway}${shown.account ? `, account ${shown.account}` : ""}.` : p2p ? " Paid to the banker's own UPI ID." : ""}
                {shown.rrn ? ` Bank reference (UTR): ${shown.rrn}.` : ""}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" disabled={check.isPending} onClick={() => check.mutate(shown.id)}>
                  <RefreshCw className="h-3.5 w-3.5" /> {shown.gateway ? "Check with the gateway" : "Check status"}
                </Button>
                {PAID.has(shown.status) && verifying && (
                  <span className="text-xs">Paid. Now, in the checklist below: <b>Look for a confirmed payment</b>, then <b>Run status check</b>.</span>
                )}
              </div>
            </div>
          </div>
        )}

        {list.length > 0 && (
          <div>
            <div className={`mb-1 text-xs font-medium ${MUTED}`}>Recent live tests</div>
            <ul className="divide-y rounded-md border text-sm">
              {list.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <button className="font-mono text-xs underline-offset-2 hover:underline" onClick={() => setShownId(t.id)}>{t.order_id}</button>
                  <span>{formatAmount(t.amount, "INR")}</span>
                  <Badge variant={statusVariant(t.status)}>{t.status}</Badge>
                  {t.account && <span className={`text-xs ${MUTED}`}>{t.account}</span>}
                  <span className={`ml-auto text-xs ${MUTED}`}>{formatDateTime(t.created_at)}{t.by ? ` · ${t.by}` : ""}</span>
                  <Button size="sm" variant="ghost" title="Copy link" onClick={() => copy(t.pay_link)}><Copy className="h-3.5 w-3.5" /></Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="border-t pt-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Rocket className="h-4 w-4" /> Go-live checklist <InfoTip label="the go-live checklist">A new gateway account takes only small payments at first. After one real payment is confirmed, mark it live to lift the limit.</InfoTip></div>
          {golive.isLoading ? <p className={`text-sm ${MUTED}`}>Loading…</p>
            : golive.error ? <p className="text-sm text-[color:var(--color-danger)]">{(golive.error as Error).message}</p>
            : accounts.length === 0 ? (
              <p className={`text-sm ${MUTED}`}>
                {p2p
                  ? "No P2P processor account of this banker is on the checklist. One appears when live credentials are saved under Intent pay-ins → Pay-in gateway with the money landing in the banker's own accounts."
                  : "No gateway account of this banker is on the checklist. One appears when live credentials are saved under Pay-in gateway; an account that was live before the checklist existed is not restricted."}
              </p>
            ) : <ul className="space-y-3">{accounts.map((a) => <GoLiveAccountCard key={a.gateway + a.account} a={a} />)}</ul>}
        </div>
      </CardContent>
    </Card>
  );
}
