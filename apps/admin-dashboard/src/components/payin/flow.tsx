"use client";

// Pay-in flow controls shared by the Pay-in Flows module and the merchant and banker pages:
// the badge that says which flow something is on, the dialog that selects it, and the card
// that shows it with its history. The rules are in lib/payin-flow.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeftRight, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn, formatDateTime } from "@/lib/utils";
import { ReadinessPreview } from "@/components/merchant/readiness";
import {
  ORDER_FLOWS, PAYIN_FLOWS, PAYIN_FLOW_HINT, PAYIN_FLOW_LABEL,
  type MerchantFlow, type OrderFlow, type PayinFlow, type PayinFlowSetting,
} from "@/lib/payin-flow";

type Variant = "brand" | "info" | "success" | "default";
const VARIANT: Record<PayinFlowSetting, Variant> = { INTENT: "brand", P2P: "info", BOTH: "success", UNSET: "default" };

/** "P2P", "Intent", "Both · Intent by default", "Not selected". */
export function flowText(f: MerchantFlow): string {
  return f.flow === "BOTH" && f.active ? `Both · ${PAYIN_FLOW_LABEL[f.active]} by default` : PAYIN_FLOW_LABEL[f.flow];
}

export function FlowBadge({ flow, active }: { flow: PayinFlowSetting; active?: OrderFlow | null }) {
  return <Badge variant={VARIANT[flow]}>{flowText({ flow, active: active ?? null })}</Badge>;
}

interface HistoryRow {
  from_flow: string | null; from_active_flow: string | null; to_flow: string; to_active_flow: string | null;
  changed_by: string | null; note: string | null; changed_at: string;
}
const histText = (flow: string | null, active: string | null) =>
  flowText({ flow: (flow ?? "UNSET") as PayinFlowSetting, active: (active as OrderFlow | null) ?? null });

export interface FlowTarget {
  /** "merchant" = a providers row; "banker" = a merchants row. */
  kind: "merchant" | "banker";
  id: string;
  name: string;
}

const endpoint = (t: FlowTarget) => (t.kind === "merchant" ? `/api/providers/${t.id}/payin-flow` : `/api/merchants/${t.id}/payin-flow`);

/**
 * Select the flow: P2P, Intent or Both, and for Both which of the two is in use. A banker can
 * also be returned to its merchant's flow.
 */
export function FlowSelectDialog({ target, current, inherited, open, onOpenChange }: {
  target: FlowTarget;
  /** The setting held by the target itself (a banker's own, not the one it inherits). */
  current: MerchantFlow;
  /** Banker only: its merchant's flow, taken when the banker has none of its own. */
  inherited?: MerchantFlow;
  open: boolean; onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [flow, setFlow] = useState<PayinFlowSetting>(current.flow);
  const [active, setActive] = useState<OrderFlow | null>(current.active);
  const [note, setNote] = useState("");
  useEffect(() => { if (open) { setFlow(current.flow); setActive(current.active); setNote(""); } }, [open, current.flow, current.active]);

  const save = useMutation({
    mutationFn: async () => {
      const r = await fetch(endpoint(target), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flow, active: flow === "BOTH" ? active : null, note: note || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Could not save the flow");
      return d;
    },
    onSuccess: () => {
      toast.success("Pay-in flow saved", { description: `${target.name}: ${flowText({ flow, active: flow === "BOTH" ? active : null })}` });
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["payin-flow"] });
      qc.invalidateQueries({ queryKey: ["payin-flows"] });
    },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });

  const valid = flow !== "BOTH" || !!active;
  const unchanged = flow === current.flow && (flow !== "BOTH" || active === current.active);
  const option = (value: PayinFlowSetting, title: string, hint: string) => (
    <button key={value} type="button" aria-pressed={flow === value} onClick={() => setFlow(value)}
      className={cn(
        "flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors",
        flow === value
          ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)]"
          : "border-[color:var(--color-border)] hover:border-[color:var(--color-text-muted)]",
      )}>
      <span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
        flow === value ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand)] text-white" : "border-[color:var(--color-border)]")}>
        {flow === value && <Check className="h-3 w-3" />}
      </span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-[color:var(--color-text-muted)]">{hint}</span>
      </span>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Pay-in flow for {target.name}</DialogTitle>
          <DialogDescription>
            {target.kind === "merchant"
              ? "Every banker under this merchant takes the flow selected here, unless a banker has its own."
              : "A flow selected here is this banker's own and is used instead of its merchant's."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {PAYIN_FLOWS.map((f: PayinFlow) => option(f, PAYIN_FLOW_LABEL[f], PAYIN_FLOW_HINT[f]))}
          {target.kind === "banker"
            ? option("UNSET", "Use the merchant's flow",
                inherited && inherited.flow !== "UNSET" ? `Currently ${flowText(inherited)}.` : "The merchant has no flow selected yet.")
            : option("UNSET", "Not selected", "Orders keep the routing they had before flows were selected.")}
        </div>

        {flow === "BOTH" && (
          <div className="space-y-1.5">
            <Label>Default flow</Label>
            <div className="grid grid-cols-2 gap-2">
              {ORDER_FLOWS.map((f) => (
                <button key={f} type="button" aria-pressed={active === f} onClick={() => setActive(f)}
                  className={cn("rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                    active === f
                      ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]"
                      : "border-[color:var(--color-border)] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]")}>
                  {PAYIN_FLOW_LABEL[f]}
                </button>
              ))}
            </div>
            <p className="text-xs text-[color:var(--color-text-muted)]">
              The P2P and Intent order APIs always use their own flow. The general order API and v2 don't name one, so they use this.
            </p>
          </div>
        )}

        {/* A merchant's flow reaches every banker under it: say which would not be ready (staff only). */}
        {target.kind === "merchant" && (
          <ReadinessPreview providerId={target.id} flow={flow} active={active} enabled={open && valid && !unchanged} />
        )}

        <div className="space-y-1.5">
          <Label>Reason <span className="font-normal text-[color:var(--color-text-muted)]">(optional, kept in the history)</span></Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. merchant asked for gateway payments" />
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !valid || unchanged}>
            {save.isPending ? "Saving…" : "Save flow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface FlowView extends MerchantFlow {
  history: HistoryRow[]; can_edit: boolean;
  // banker only
  source?: "BANKER" | "MERCHANT" | "NONE"; own?: MerchantFlow; inherited?: MerchantFlow;
  readiness?: { p2p: boolean; intent: boolean };
}

/** The flow of one merchant or banker, with what it still needs and who changed it. */
export function PayinFlowCard({ target }: { target: FlowTarget }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["payin-flow", target.kind, target.id],
    queryFn: async () => {
      const r = await fetch(endpoint(target));
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error ?? "Could not load the pay-in flow");
      return d as FlowView;
    },
  });
  const d = q.data;
  const own: MerchantFlow = d ? (target.kind === "banker" ? d.own ?? { flow: "UNSET", active: null } : { flow: d.flow, active: d.active }) : { flow: "UNSET", active: null };
  const needs = (f: OrderFlow) => (f === "P2P" ? "a settlement UPI ID" : "a connected pay-in gateway");
  const inForce: OrderFlow[] = !d ? [] : d.flow === "BOTH" ? ["P2P", "INTENT"] : d.flow === "UNSET" ? [] : [d.flow];
  const missing = d?.readiness ? inForce.filter((f) => !(f === "P2P" ? d.readiness!.p2p : d.readiness!.intent)) : [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base"><ArrowLeftRight className="h-4 w-4" /> Pay-in flow</CardTitle>
          <CardDescription>
            {target.kind === "merchant"
              ? "Which Katana pay-in flow this merchant's bankers take: P2P, Intent or Both."
              : "Which Katana pay-in flow this banker's orders take."}
          </CardDescription>
        </div>
        {d?.can_edit && <Button variant="secondary" onClick={() => setOpen(true)}>Change</Button>}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {q.isLoading ? <div className="text-[color:var(--color-text-muted)]">Loading…</div>
          : q.isError || !d ? <div className="text-[color:var(--color-danger)]">{(q.error as Error)?.message ?? "Could not load the pay-in flow"}</div>
          : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <FlowBadge flow={d.flow} active={d.active} />
                {target.kind === "banker" && d.source === "MERCHANT" && <span className="text-xs text-[color:var(--color-text-muted)]">taken from its merchant</span>}
                {target.kind === "banker" && d.source === "BANKER" && <span className="text-xs text-[color:var(--color-text-muted)]">this banker&apos;s own</span>}
                {d.flow === "UNSET" && <span className="text-xs text-[color:var(--color-text-muted)]">orders keep the routing they had before flows were selected</span>}
              </div>
              {missing.length > 0 && (
                <div className="rounded-md border border-[color:var(--color-warning)] px-3 py-2 text-xs">
                  {missing.map((f) => `${PAYIN_FLOW_LABEL[f]} needs ${needs(f)}`).join("; ")}. Live orders on that flow are refused until it is set up.
                </div>
              )}
              {d.history.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[color:var(--color-text-muted)]">History</div>
                  <ul className="space-y-1">
                    {d.history.slice(0, 5).map((h) => (
                      <li key={h.changed_at} className="text-xs">
                        <span className="font-medium">{histText(h.from_flow, h.from_active_flow)} → {histText(h.to_flow, h.to_active_flow)}</span>
                        <span className="text-[color:var(--color-text-muted)]"> · {formatDateTime(h.changed_at)}{h.changed_by ? ` · ${h.changed_by}` : ""}{h.note ? ` · ${h.note}` : ""}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
      </CardContent>
      {d && <FlowSelectDialog target={target} current={own} inherited={d.inherited} open={open} onOpenChange={setOpen} />}
    </Card>
  );
}
