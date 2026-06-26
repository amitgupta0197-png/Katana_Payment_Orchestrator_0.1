"use client";

// PoolPay S2S order creation + payment panel.
// Create order -> deeplink response -> Paytm / PhonePe / QR-UPI buttons ->
// poll status enquiry until final status. Used on the PoolPay cockpit.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Copy, Smartphone, QrCode, ExternalLink } from "lucide-react";
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

interface DeepLinks { paytm: string; phonepe: string; upi: string }
interface CreatedOrder {
  order: { id: string; order_id: string; amount: number; currency_code: string; status: string };
  deeplinks: DeepLinks;
  upi_intent: string;
  qr_payload: string;
}

const MUTED = "text-[color:var(--color-text-muted)]";

export function PoolPayCreateOrder({ onChange }: { onChange?: () => void }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ amount: "499", customer_vpa: "", customer_phone: "", order_ref: "" });
  const [active, setActive] = useState<CreatedOrder | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/vendors/poolpay/order", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: form.amount,
          customer_vpa: form.customer_vpa || undefined,
          customer_phone: form.customer_phone || undefined,
          order_ref: form.order_ref || undefined,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as CreatedOrder;
    },
    onSuccess: (data) => {
      toast.success("PoolPay order created — deeplinks ready");
      setCreateOpen(false);
      setActive(data);
      onChange?.();
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  return (
    <>
      <Button onClick={() => setCreateOpen(true)}><Plus /> Create S2S order</Button>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create PoolPay S2S order</DialogTitle>
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
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Customer VPA <span className={`font-normal ${MUTED}`}>(optional)</span></Label>
                <Input value={form.customer_vpa} onChange={(e) => setForm({ ...form, customer_vpa: e.target.value })} placeholder="name@upi" />
              </div>
              <div className="space-y-1.5">
                <Label>Customer phone <span className={`font-normal ${MUTED}`}>(optional)</span></Label>
                <Input value={form.customer_phone} onChange={(e) => setForm({ ...form, customer_phone: e.target.value })} placeholder="9XXXXXXXXX" />
              </div>
            </div>
            <p className={`text-xs ${MUTED}`}>Sandbox tip: amounts ending in .13 fail, .11 expire, others settle after ~8s.</p>
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
  const q = useQuery({
    queryKey: ["poolpay-order", id],
    queryFn: async () => {
      const r = await fetch(`/api/vendors/poolpay/order/${id}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as { status: string; terminal: boolean; order: { rrn?: string } };
    },
    refetchInterval: (query) => (query.state.data?.terminal ? false : 3000),
    initialData: { status: created.order.status, terminal: false, order: {} },
  });
  const status = q.data?.status ?? created.order.status;
  const terminal = q.data?.terminal ?? false;
  const dl = created.deeplinks;
  const rrn = q.data?.order?.rrn;
  const payLink = `${typeof window !== "undefined" ? window.location.origin : ""}/pay/${created.order.id}`;
  const copy = (t: string) => { navigator.clipboard?.writeText(t); toast.success("Copied"); };

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
            <Button asChild variant="secondary" className="w-full justify-start">
              <a href={dl.paytm}><Smartphone /> Pay with Paytm</a>
            </Button>
            <Button asChild variant="secondary" className="w-full justify-start">
              <a href={dl.phonepe}><Smartphone /> Pay with PhonePe</a>
            </Button>
            <Button asChild variant="secondary" className="w-full justify-start">
              <a href={dl.upi}><QrCode /> QR / Generic UPI</a>
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
