"use client";

// What a merchant is onboarded for: pay-in, pay-out or both. The badge, the card that shows and
// changes the services on the merchant's page, and the notice on a portal's Integration page.
// Choosing them step by step is components/merchant/onboarding-wizard. Rules: lib/merchant-services.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn, formatDateTime } from "@/lib/utils";
import { MERCHANT_SERVICES, SERVICES_HINT, SERVICES_LABEL, type MerchantServicesSetting } from "@/lib/merchant-services";

const VARIANT: Record<MerchantServicesSetting, "brand" | "info" | "success" | "default"> = {
  PAYIN: "info", PAYOUT: "brand", BOTH: "success", UNSET: "default",
};

export function ServicesBadge({ services }: { services: MerchantServicesSetting }) {
  return <Badge variant={VARIANT[services]}>{SERVICES_LABEL[services]}</Badge>;
}

function Option({ selected, title, hint, onClick }: { selected: boolean; title: string; hint: string; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={selected} onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md border p-2.5 text-left transition-colors",
        selected
          ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)]"
          : "border-[color:var(--color-border)] hover:border-[color:var(--color-text-muted)]",
      )}>
      <span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
        selected ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand)] text-white" : "border-[color:var(--color-border)]")}>
        {selected && <Check className="h-3 w-3" />}
      </span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-[color:var(--color-text-muted)]">{hint}</span>
      </span>
    </button>
  );
}

interface HistoryRow { from_services: string | null; to_services: string; changed_by: string | null; note: string | null; changed_at: string }
interface ServicesData { services: MerchantServicesSetting; history: HistoryRow[]; can_edit: boolean }

/** A merchant's services with their history, and for staff the dialog that changes them. */
export function ServicesCard({ providerId, name, preview }: {
  providerId: string; name: string;
  /** What the choice being made would mean for the merchant's bankers (components/merchant/readiness). */
  preview?: (services: MerchantServicesSetting, enabled: boolean) => React.ReactNode;
}) {
  const qc = useQueryClient();
  const key = ["merchant-services", providerId];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/providers/${providerId}/services`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as ServicesData;
    },
  });
  const [open, setOpen] = useState(false);
  const [services, setServices] = useState<MerchantServicesSetting>("UNSET");
  const [note, setNote] = useState("");
  useEffect(() => { if (open && q.data) { setServices(q.data.services); setNote(""); } }, [open, q.data]);

  const save = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/providers/${providerId}/services`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ services, note: note || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Could not save the services");
      return d;
    },
    onSuccess: () => {
      toast.success("Services saved", { description: `${name}: ${SERVICES_LABEL[services]}` });
      setOpen(false);
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["providers"] });
    },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });

  const current = q.data?.services ?? "UNSET";
  const text = (v: string | null) => SERVICES_LABEL[(v ?? "UNSET") as MerchantServicesSetting] ?? v;
  return (
    <Card className="mt-4">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-1.5 text-base">Services <InfoTip label="services">What this merchant may do: take payments in, send payouts, or both. Anything not chosen is refused.</InfoTip></CardTitle>
          <CardDescription>
            What this merchant was onboarded for. Its bankers take pay-in orders only when pay-in is included, and send
            payouts only when pay-out is.
          </CardDescription>
        </div>
        {q.data?.can_edit && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Change</Button>}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {q.isLoading ? <p className="text-[color:var(--color-text-muted)]">Loading…</p>
          : q.error ? <p className="text-[color:var(--color-danger)]">{(q.error as Error).message}</p>
          : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <ServicesBadge services={current} />
                {current === "UNSET" && <span className="text-xs text-[color:var(--color-text-muted)]">Nothing selected: pay-ins and payouts are both allowed, as before.</span>}
              </div>
              {(q.data?.history.length ?? 0) > 0 && (
                <ul className="space-y-1 text-xs text-[color:var(--color-text-muted)]">
                  {q.data!.history.map((h, i) => (
                    <li key={i}>{formatDateTime(h.changed_at)}: {text(h.from_services)} → {text(h.to_services)}{h.changed_by ? ` by ${h.changed_by}` : ""}{h.note ? ` (${h.note})` : ""}</li>
                  ))}
                </ul>
              )}
            </>
          )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Services for {name}</DialogTitle>
            <DialogDescription>Applies to every banker under this merchant from the next order or payout.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {MERCHANT_SERVICES.map((s) => (
              <Option key={s} selected={services === s} title={SERVICES_LABEL[s]} hint={SERVICES_HINT[s]} onClick={() => setServices(s)} />
            ))}
            <Option selected={services === "UNSET"} title="Not selected" hint="Pay-ins and payouts are both allowed, as before a choice was made." onClick={() => setServices("UNSET")} />
          </div>
          {preview?.(services, open && services !== current)}
          <div className="space-y-1.5">
            <Label>Reason <span className="font-normal text-[color:var(--color-text-muted)]">(optional, kept in the history)</span></Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || services === current}>{save.isPending ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * Says on a merchant's or banker's own Integration page which of the two APIs the account is
 * set up for. Nothing is shown for an account that has both, or one nobody chose for.
 */
export function ServicesNotice({ services }: { services: MerchantServicesSetting }) {
  if (services !== "PAYIN" && services !== "PAYOUT") return null;
  return (
    <div role="note" className="mb-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-muted)] p-3 text-sm">
      <span className="font-medium">This account is set up for {services === "PAYIN" ? "pay-ins" : "payouts"} only. </span>
      {services === "PAYIN"
        ? "The payout API is not enabled: a payout request is refused with PAYOUT_NOT_ENABLED."
        : "The pay-in order APIs are not enabled: an order request is refused with PAYIN_NOT_ENABLED. Use the payout API in the API kit."}
      {" "}Ask your Katana account manager to change it.
    </div>
  );
}
