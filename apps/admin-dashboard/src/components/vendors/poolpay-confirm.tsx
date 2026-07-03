"use client";

// Operations confirmation control for a pending PoolPay order. The ops team
// verifies the credit — via the sender's uploaded screenshot, a bank/gateway
// reference, or scraping — records the UTR/RRN, and marks the order paid or failed.
// When the sender has uploaded a payment proof, this dialog surfaces it (UTR
// prefilled + a link to view the screenshot) so the reviewer can confirm against it.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, ShieldCheck, FileImage } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

interface Proof { id: string; kind: string; utr: string | null; filename: string | null; content_type: string; created_at: string }

export function PoolPayConfirm({ id, orderId, proofUtr, hasProof, onDone }: {
  id: string; orderId: string; proofUtr?: string; hasProof?: boolean; onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [utr, setUtr] = useState("");
  const [note, setNote] = useState("");

  // Prefill the UTR the sender typed when submitting their screenshot.
  useEffect(() => { if (open && proofUtr) setUtr(proofUtr); }, [open, proofUtr]);

  // Load uploaded proofs (only when the dialog is open and a proof exists).
  const proofsQ = useQuery({
    queryKey: ["poolpay-proofs", id],
    enabled: open && !!hasProof,
    queryFn: async () => {
      const r = await fetch(`/api/vendors/poolpay/order/${id}/proof`);
      if (!r.ok) throw new Error("failed to load proofs");
      return (await r.json()) as { proofs: Proof[] };
    },
  });
  const proofs = proofsQ.data?.proofs ?? [];

  const m = useMutation({
    mutationFn: async (outcome: "SUCCESS" | "FAILED") => {
      const r = await fetch(`/api/vendors/poolpay/order/${id}/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome, utr: utr || undefined, note: note || undefined,
          evidence: hasProof ? "SCREENSHOT" : utr ? "UTR" : "MANUAL",
        }),
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
      <Button size="sm" variant="ghost" title={hasProof ? "Review proof / confirm order" : "Confirm / reconcile order"} onClick={() => setOpen(true)}>
        <ShieldCheck className={`h-3.5 w-3.5 ${hasProof ? "text-[color:var(--color-warning)]" : ""}`} />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm order <span className="font-mono">{orderId}</span></DialogTitle>
            <DialogDescription>
              Reconcile this pending pay-in. Verify the credit against the sender&apos;s screenshot,
              the bank statement, or scraping, then mark the result.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {hasProof && (
              <div className="rounded-md border border-[color:var(--color-warning)]/30 bg-[color:var(--color-warning-muted)] p-2.5 text-xs">
                <div className="mb-1 font-medium text-[color:var(--color-warning)]">Sender submitted payment proof</div>
                {proofs.length === 0 ? (
                  <span className="text-[color:var(--color-text-muted)]">{proofsQ.isLoading ? "Loading…" : "Screenshot attached."}</span>
                ) : (
                  <div className="space-y-1">
                    {proofs.map((p) => (
                      <a key={p.id} href={`/api/vendors/poolpay/order/${id}/proof?file=${p.id}`} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-[color:var(--color-brand)] hover:underline">
                        <FileImage className="h-3.5 w-3.5" /> View {p.filename || p.kind.toLowerCase()}{p.utr ? ` · UTR ${p.utr}` : ""}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
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
