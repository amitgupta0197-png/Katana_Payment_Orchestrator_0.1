"use client";

// PoolPay S2S order creation + payment panel.
// Create order -> deeplink response -> Paytm / PhonePe / QR-UPI buttons ->
// poll status enquiry until final status. Used on the PoolPay cockpit.

import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Copy, QrCode, ExternalLink } from "lucide-react";
import { PaytmLogo, PhonePeLogo, GooglePayLogo } from "@/components/icons/upi-apps";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { formatAmount, statusVariant } from "@/lib/utils";
import { openUpiApp } from "@/lib/upi";

interface DeepLinks { paytm: string; phonepe: string; upi: string }
interface CreatedOrder {
  order: { id: string; order_id: string; amount: number; currency_code: string; status: string };
  deeplinks: DeepLinks;
  upi_intent: string;
  qr_payload: string;
}

const MUTED = "text-[color:var(--color-text-muted)]";

// `endpoint` lets this same module be reused outside the vendor cockpit — e.g. the
// merchant detail page passes /api/merchants/[id]/payin-orders so the created order
// is scoped to that merchant (sub-MID routing + risk rules). Both endpoints accept
// the same body and return the same { order, deeplinks, upi_intent } shape.
export function PoolPayCreateOrder({
  onChange, endpoint = "/api/vendors/poolpay/order", buttonLabel = "Create S2S order", receiverPlaceholder,
}: {
  onChange?: () => void;
  endpoint?: string;
  buttonLabel?: string;
  receiverPlaceholder?: string;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ amount: "499", receiver_vpas: "", customer_vpa: "", customer_phone: "", order_ref: "", mode: "QR" });
  const [active, setActive] = useState<CreatedOrder | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: form.amount,
          mode: form.mode,
          receiver_vpas: form.receiver_vpas.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean),
          customer_vpa: form.customer_vpa || undefined,
          customer_phone: form.customer_phone || undefined,
          order_ref: form.order_ref || undefined,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as CreatedOrder;
    },
    onSuccess: (data) => {
      toast.success("Katana Pay order created — deeplinks ready");
      setCreateOpen(false);
      setActive(data);
      onChange?.();
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  return (
    <>
      <Button onClick={() => setCreateOpen(true)}><Plus /> {buttonLabel}</Button>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Katana Pay S2S order</DialogTitle>
            <DialogDescription>Server-to-server pay-in. Returns Paytm / PhonePe / UPI deeplinks for the payment page.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Amount (INR)</Label>
                <Input type="number" min="1" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Order ref <span className={`font-normal ${MUTED}`}>(optional)</span></Label>
                <Input value={form.order_ref} onChange={(e) => setForm({ ...form, order_ref: e.target.value })} placeholder="auto-generated" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Payment mode</Label>
              <div className="flex gap-2">
                {(["QR", "INTENT"] as const).map((mk) => (
                  <button key={mk} type="button" onClick={() => setForm({ ...form, mode: mk })}
                    className={`flex-1 rounded-xl border px-3 py-2 text-sm transition ${
                      form.mode === mk
                        ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]"
                        : `border-[color:var(--color-border)] ${MUTED} hover:bg-[color:var(--color-surface-muted)]`
                    }`}>
                    {mk === "QR" ? "QR based" : "Non-QR (app deeplink)"}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Receiver UPI pool <span className={`font-normal ${MUTED}`}>(payee — 1 to 25, one per line; first is primary, rest are backups)</span></Label>
              <textarea
                className="flex min-h-[84px] w-full rounded-xl border px-3 py-2 text-sm bg-[color:var(--color-surface)]"
                value={form.receiver_vpas}
                onChange={(e) => setForm({ ...form, receiver_vpas: e.target.value })}
                placeholder={receiverPlaceholder ?? "merchant1@upi\nmerchant2@upi\nmerchant3@upi"}
              />
              <p className={`text-xs ${MUTED}`}>If a VPA can&apos;t receive, operations fail it over to the next backup.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Sender UPI <span className={`font-normal ${MUTED}`}>(payer, optional)</span></Label>
                <Input value={form.customer_vpa} onChange={(e) => setForm({ ...form, customer_vpa: e.target.value })} placeholder="customer@upi" />
              </div>
              <div className="space-y-1.5">
                <Label>Customer phone <span className={`font-normal ${MUTED}`}>(optional)</span></Label>
                <Input value={form.customer_phone} onChange={(e) => setForm({ ...form, customer_phone: e.target.value })} placeholder="9XXXXXXXXX" />
              </div>
            </div>
            <p className={`text-xs ${MUTED}`}>Orders stay PENDING until paid &amp; confirmed (webhook / UTR). Sandbox: amounts ending .13 fail, .11 expire, .99 force-succeed; others await confirmation.</p>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending || !form.amount}>
              {create.isPending ? "Creating…" : "Create order"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {active && <PaymentPanel created={active} onClose={() => { setActive(null); onChange?.(); }} />}
    </>
  );
}

function PaymentPanel({ created, onClose }: { created: CreatedOrder; onClose: () => void }) {
  const id = created.order.id;
  // Poll the public pay-status endpoint — it's readable by every persona (the order
  // id in the URL is the capability) so this panel works from the cockpit AND the
  // merchant/provider-scoped merchant page without an auth mismatch.
  const q = useQuery({
    queryKey: ["pay-status", id],
    queryFn: async () => {
      const r = await fetch(`/api/pay-status/${id}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as { status: string; terminal: boolean; rrn?: string | null };
    },
    refetchInterval: (query) => (query.state.data?.terminal ? false : 3000),
    initialData: { status: created.order.status, terminal: false, rrn: null },
  });
  const status = q.data?.status ?? created.order.status;
  const terminal = q.data?.terminal ?? false;
  const rrn = q.data?.rrn;
  const payLink = `${typeof window !== "undefined" ? window.location.origin : ""}/pay/${created.order.id}`;
  const copy = (t: string) => { navigator.clipboard?.writeText(t); toast.success("Copied"); };

  // Auto-close on a successful payment: once the order settles to SUCCESS, show the
  // "Payment received" state briefly, then dismiss the dialog automatically (~2s) so
  // the operator doesn't have to click Close. Only auto-closes on success — FAILED /
  // EXPIRED stay open so the operator sees the outcome and dismisses it themselves.
  const autoClosed = useRef(false);
  useEffect(() => {
    if (autoClosed.current) return;
    if (status === "SUCCESS" || status === "SUCCEEDED") {
      autoClosed.current = true;
      toast.success("Payment received — closing");
      const t = setTimeout(() => onClose(), 2000);
      return () => clearTimeout(t);
    }
  }, [status, onClose]);

  // Sandbox: simulate the bank-credit transaction alert (Android agent) so the
  // reconciler matches it to this order and confirms it — the panel then flips to
  // "Payment received" on the next poll.
  const sim = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/vendors/poolpay/order/${id}/simulate-credit`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as { outcome: string; detail?: string };
    },
    onSuccess: (d) => {
      if (d.outcome === "CONFIRMED") toast.success("Bank credit matched — order confirmed");
      else toast.info(`Alert ${String(d.outcome).toLowerCase()}`, { description: d.detail });
      q.refetch();
    },
    onError: (e: Error) => toast.error("Simulate failed", { description: e.message }),
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Complete payment</DialogTitle>
          <DialogDescription>
            Order <span className="font-mono">{created.order.order_id}</span> · {formatAmount(created.order.amount, created.order.currency_code)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between rounded-md border p-3">
          <span className={`text-sm ${MUTED}`}>Status</span>
          <Badge variant={statusVariant(status)}>{status}</Badge>
        </div>

        {!terminal ? (
          <div className="space-y-2 min-w-0">
            <div className="flex flex-col items-center pb-1">
              <div className="rounded-2xl bg-white p-2.5 shadow-inner">
                <QRCodeSVG value={created.upi_intent} size={150} level="M" />
              </div>
              <div className={`mt-2 text-xs ${MUTED}`}>Scan with any UPI app</div>
            </div>
            <Button variant="secondary" className="w-full justify-start gap-2" onClick={() => openUpiApp("paytm", created.upi_intent)}>
              <PaytmLogo /> Pay with Paytm
            </Button>
            <Button variant="secondary" className="w-full justify-start gap-2" onClick={() => openUpiApp("phonepe", created.upi_intent)}>
              <PhonePeLogo /> Pay with PhonePe
            </Button>
            <Button variant="secondary" className="w-full justify-start gap-2" onClick={() => openUpiApp("gpay", created.upi_intent)}>
              <GooglePayLogo /> Pay with Google Pay
            </Button>
            <Button variant="secondary" className="w-full justify-start" onClick={() => openUpiApp("any", created.upi_intent)}>
              <QrCode /> QR / Generic UPI
            </Button>
            <div className="min-w-0 overflow-hidden rounded-md border bg-[color:var(--color-surface-muted)] p-2">
              <div className={`mb-1 text-xs ${MUTED}`}>Customer payment link (share with the payer):</div>
              <div className="flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-xs">{payLink}</code>
                <Button size="sm" variant="ghost" className="shrink-0" onClick={() => copy(payLink)} title="Copy link"><Copy className="h-4 w-4" /></Button>
                <Button asChild size="sm" variant="ghost" className="shrink-0" title="Open"><a href={payLink} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4" /></a></Button>
              </div>
            </div>
            <p className={`text-xs ${MUTED}`}>Waiting for the customer to pay — status updates automatically.</p>
            <Button variant="ghost" size="sm" className="w-full text-xs" onClick={() => sim.mutate()} disabled={sim.isPending}>
              {sim.isPending ? "Simulating bank credit…" : "Simulate bank credit (sandbox)"}
            </Button>
          </div>
        ) : (
          <div className="rounded-md border p-3 text-sm">
            {status === "SUCCESS" || status === "SUCCEEDED"
              ? "Payment received."
              : status === "FAILED" ? "Payment failed." : "Payment request expired."}
            {rrn ? <div className={`mt-1 text-xs ${MUTED}`}>RRN: <span className="font-mono">{rrn}</span></div> : null}
          </div>
        )}

        <DialogFooter><Button variant="secondary" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
