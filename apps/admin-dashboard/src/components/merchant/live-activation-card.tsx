"use client";

// "Activate live mode" — the checklist a banker completes before taking real payments, and the
// Super Admin's approve / reject. One card for both sides:
//   banker portal  → /api/me/live-activation             (request activation)
//   merchant pages → /api/merchants/[id]/live-activation  (approve / reject; PROVIDER read-only)
// useLiveActivation() is shared with the key cards, which disable live generation until active.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Rocket } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/utils";

export type ActivationStatus = "NOT_REQUESTED" | "REQUESTED" | "ACTIVATED" | "REJECTED";

export interface LiveActivation {
  merchant_code: string;
  status: ActivationStatus;
  grandfathered: boolean;
  requested_at: string | null;
  requested_by: string | null;
  decided_at: string | null;
  decided_by: string | null;
  reason: string | null;
  checklist: { key: string; label: string; done: boolean; hint: string }[];
  ready: boolean;
}

const MUTED = "text-[color:var(--color-text-muted)]";

const STATUS: Record<ActivationStatus, { label: string; variant: "success" | "warning" | "danger" | "default" }> = {
  NOT_REQUESTED: { label: "Not activated", variant: "default" },
  REQUESTED: { label: "Waiting for approval", variant: "warning" },
  ACTIVATED: { label: "Live mode active", variant: "success" },
  REJECTED: { label: "Not approved", variant: "danger" },
};

function endpoint(merchantId?: string) {
  return merchantId ? `/api/merchants/${merchantId}/live-activation` : "/api/me/live-activation";
}

export function liveActivationKey(merchantId?: string) {
  return merchantId ? ["merchant", merchantId, "live-activation"] : ["me-live-activation"];
}

/** Live mode state for a banker (merchantId) or for the signed-in banker (no merchantId). */
export function useLiveActivation(merchantId?: string) {
  return useQuery({
    queryKey: liveActivationKey(merchantId),
    queryFn: async () => {
      const r = await fetch(endpoint(merchantId));
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as LiveActivation;
    },
  });
}

export function LiveActivationCard({ merchantId, canDecide = false }: { merchantId?: string; canDecide?: boolean }) {
  const qc = useQueryClient();
  const q = useLiveActivation(merchantId);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const d = q.data;

  const act = useMutation({
    mutationFn: async (v: { body?: Record<string, unknown>; done: string }) => {
      const r = await fetch(endpoint(merchantId), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(v.body ?? {}),
      });
      const dd = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(dd.error ?? "Failed");
      return { state: dd as LiveActivation, done: v.done };
    },
    onSuccess: ({ state, done }) => {
      qc.setQueryData(liveActivationKey(merchantId), state);
      setRejecting(false);
      setReason("");
      toast.success(done);
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const status = d ? STATUS[d.status] : null;
  const active = d?.status === "ACTIVATED";

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="inline-flex items-center gap-2 text-base"><Rocket className="h-4 w-4" />Activate live mode</CardTitle>
          <CardDescription>
            {merchantId
              ? "Live keys and live orders stay blocked for this banker until live mode is activated. The banker completes the checklist and requests it; a Super Admin approves."
              : "Your test keys work straight away. To take real payments, complete this checklist and request activation. Katana reviews it and turns on live mode."}
          </CardDescription>
        </div>
        {status && <Badge variant={status.variant} className="shrink-0">{status.label}</Badge>}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {q.isLoading ? <p className={MUTED}>Loading…</p> : q.isError ? (
          <p className="text-[color:var(--color-danger)]">{(q.error as Error).message}</p>
        ) : d && active ? (
          <p>
            Live mode is active{d.grandfathered
              ? ": this account was already taking live payments when activation was introduced."
              : `${d.decided_at ? ` since ${formatDateTime(d.decided_at)}` : ""}${d.decided_by ? `, approved by ${d.decided_by}` : ""}.`}
          </p>
        ) : d && (
          <>
            <ul className="space-y-2.5">
              {d.checklist.map((item) => (
                <li key={item.key} className="flex gap-2.5">
                  {item.done
                    ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-success)]" aria-label="Done" />
                    : <Circle className={`mt-0.5 h-4 w-4 shrink-0 ${MUTED}`} aria-label="Not done" />}
                  <div>
                    <div className={item.done ? "" : "font-medium"}>{item.label}</div>
                    {!item.done && <div className={`text-xs ${MUTED}`}>{item.hint}</div>}
                  </div>
                </li>
              ))}
            </ul>

            {d.status === "REQUESTED" && (
              <p className={`rounded-md border px-3 py-2 text-xs ${MUTED}`}>
                Requested{d.requested_at ? ` ${formatDateTime(d.requested_at)}` : ""}{d.requested_by ? ` by ${d.requested_by}` : ""}.
                {merchantId ? "" : " Katana will review it; live keys unlock as soon as it is approved."}
              </p>
            )}
            {d.status === "REJECTED" && d.reason && (
              <div className="rounded-md border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger-muted)] px-3 py-2 text-xs">
                <span className="font-medium">Not approved:</span> {d.reason}
                {merchantId ? "" : " Fix this, then request activation again."}
              </div>
            )}

            {!merchantId && (
              <Button
                disabled={!d.ready || d.status === "REQUESTED" || act.isPending}
                onClick={() => act.mutate({ done: "Activation requested" })}
              >
                <Rocket className="h-4 w-4" />
                {d.status === "REQUESTED" ? "Activation requested" : act.isPending ? "Requesting…" : "Request activation"}
              </Button>
            )}

            {merchantId && canDecide && (
              <div className="space-y-3 border-t pt-3">
                {!d.ready && (
                  <p className="text-xs text-[color:var(--color-warning)]">
                    The checklist is not complete. Approving now overrides it and is recorded in the activity log.
                  </p>
                )}
                {rejecting ? (
                  <div className="space-y-2">
                    <Label htmlFor="live-activation-reason">Reason (shown to the banker)</Label>
                    <Input id="live-activation-reason" value={reason} maxLength={500}
                      onChange={(e) => setReason(e.target.value)} placeholder="e.g. Webhook URL does not respond" />
                    <div className="flex gap-2">
                      <Button variant="secondary" onClick={() => { setRejecting(false); setReason(""); }}>Cancel</Button>
                      <Button disabled={!reason.trim() || act.isPending}
                        onClick={() => act.mutate({ body: { decision: "REJECT", reason }, done: "Activation rejected" })}>
                        {act.isPending ? "Saving…" : "Reject"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={act.isPending}
                      onClick={() => act.mutate({ body: { decision: "APPROVE" }, done: "Live mode activated" })}>
                      {act.isPending ? "Saving…" : "Approve live mode"}
                    </Button>
                    <Button variant="secondary" disabled={act.isPending} onClick={() => setRejecting(true)}>Reject</Button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
