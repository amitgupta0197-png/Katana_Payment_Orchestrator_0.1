"use client";

// Operations confirmation control for a pending PoolPay order. The ops team
// records the UTR/RRN (from scraping, a customer screenshot, or a bank/gateway
// webhook) and marks the order paid or failed. Posts to the confirm endpoint.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, XCircle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

export function PoolPayConfirm({ id, orderId, onDone }: { id: string; orderId: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [utr, setUtr] = useState("");
  const [note, setNote] = useState("");

  const m = useMutation({
    mutationFn: async (outcome: "SUCCESS" | "FAILED") => {
      const r = await fetch(`/api/vendors/poolpay/order/${id}/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, utr: utr || undefined, note: note || undefined, evidence: utr ? "UTR" : "MANUAL" }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: (_d, outcome) => {
      toast.success(outcome === "SUCCESS" ? "Order confirmed — marked paid" : "Order marked failed");
      setOpen(false); setUtr(""); setNote("");
      onDone?.();
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  return (
    <>
      <Button size="sm" variant="ghost" title="Confirm / reconcile order" onClick={() => setOpen(true)}>
        <ShieldCheck className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm order <span className="font-mono">{orderId}</span></DialogTitle>
            <DialogDescription>
              Reconcile this pending pay-in. Enter the UTR/RRN from the bank statement, scraping, or
              the customer&apos;s payment screenshot, then mark the result.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>UTR / RRN <span className="font-normal text-[color:var(--color-text-muted)]">(bank reference)</span></Label>
              <Input value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="e.g. 412345678901" />
            </div>
            <div className="space-y-1.5">
              <Label>Note <span className="font-normal text-[color:var(--color-text-muted)]">(optional)</span></Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="screenshot verified / reconciliation source" />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="secondary" onClick={() => m.mutate("FAILED")} disabled={m.isPending}>
              <XCircle className="h-4 w-4" /> Mark failed
            </Button>
            <Button onClick={() => m.mutate("SUCCESS")} disabled={m.isPending}>
              <CheckCircle2 className="h-4 w-4" /> {m.isPending ? "Saving…" : "Confirm paid"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
