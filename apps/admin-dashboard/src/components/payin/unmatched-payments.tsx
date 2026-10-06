"use client";

// "Unmatched payments" (lib/unmatched): money that arrived with no order, and the orders it could be
// for. Shared by the staff page and both portals; what each login may do comes from the API.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HandCoins } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import type { UnmatchedPayment } from "@/lib/unmatched-store";

const MUTED = "text-[color:var(--color-text-muted)]";
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

interface List { payments: UnmatchedPayment[]; staff: boolean; canLink: boolean }

export function UnmatchedPayments({ banker = null }: { banker?: string | null }) {
  const qc = useQueryClient();
  const [marked, setMarked] = useState(false);
  const key = ["unmatched", banker, marked];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const p = new URLSearchParams();
      if (banker) p.set("banker", banker);
      if (marked) p.set("marked", "1");
      const r = await fetch(`/api/unmatched?${p}`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d as List;
    },
    refetchInterval: 60_000,
  });
  const act = useMutation({
    mutationFn: async (v: { id: string; action: string; order_id?: string }) => {
      const r = await fetch(`/api/unmatched/${v.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d as { state: string };
    },
    onSuccess: (d) => { toast.success(d.state); void qc.invalidateQueries({ queryKey: ["unmatched"] }); },
    onError: (e: Error) => toast.error("Not done", { description: e.message }),
  });
  const d = q.data;
  const [pick, setPick] = useState<Record<string, string>>({});

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-1.5">
            <HandCoins className="h-4 w-4" /> Unmatched payments
            <InfoTip label="unmatched payments">Money arrived, but Katana could not tell which order it was for. Pick the right order, or mark it as not an order payment.</InfoTip>
          </span>
          {d?.staff && (
            <label className={`flex items-center gap-1.5 text-xs font-normal ${MUTED}`}>
              <input type="checkbox" checked={marked} onChange={(e) => setMarked(e.target.checked)} /> Show ones marked "not an order"
            </label>
          )}
        </CardTitle>
        <CardDescription>
          {d?.canLink ? "Linking marks the order paid with this payment's bank reference." : "When you pick an order, Katana checks it and then marks the order paid."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? <p className={`py-6 text-center text-sm ${MUTED}`}>Loading…</p>
          : q.error ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>
          : !d?.payments.length ? <p className={`py-8 text-center text-sm ${MUTED}`}>No payment is waiting for an order.</p>
          : (
            <ul className="divide-y">
              {d.payments.map((p) => {
                const pending = p.review?.status === "PENDING";
                const notOrder = p.review?.decision === "NOT_ORDER" && p.review.status === "DONE";
                const choice = pick[p.id] ?? p.candidates[0]?.id ?? "";
                return (
                  <li key={p.id} className="flex flex-wrap items-start gap-3 py-3">
                    <div className="min-w-0 flex-1 basis-72">
                      <div className="text-sm font-medium">{inr(p.amount)} <span className={`font-normal ${MUTED}`}>· {when(p.received_at)}</span></div>
                      <div className={`text-xs ${MUTED}`}>
                        {d.staff && <span className="font-mono">{p.banker} · </span>}
                        Bank reference (UTR) {p.utr ?? "not read"}{p.payer ? ` · from ${p.payer}` : ""}{p.app ? ` · ${p.app}` : ""}
                      </div>
                      <div className="mt-1"><Badge variant={pending ? "warning" : notOrder ? "default" : p.review?.status === "REJECTED" ? "danger" : "info"}>{p.state}</Badge></div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {pending && d.canLink ? (
                        <>
                          <Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: p.id, action: "approve" })}>Approve link</Button>
                          <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ id: p.id, action: "reject" })}>Refuse</Button>
                        </>
                      ) : notOrder ? (
                        d.staff && <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ id: p.id, action: "undo" })}>Undo</Button>
                      ) : !pending && (
                        <>
                          {p.candidates.length > 0 ? (
                            <>
                              <select aria-label="Order this payment is for" value={choice} onChange={(e) => setPick({ ...pick, [p.id]: e.target.value })}
                                className="h-8 max-w-56 rounded-md border bg-[color:var(--color-surface)] px-2 text-xs">
                                {p.candidates.map((o) => <option key={o.id} value={o.id}>{o.order_id} · {when(o.created_at)}</option>)}
                              </select>
                              <Button size="sm" disabled={!choice || act.isPending} onClick={() => act.mutate({ id: p.id, action: "link", order_id: choice })}>
                                {d.canLink ? "Link to this order" : "This payment is for this order"}
                              </Button>
                            </>
                          ) : <span className={`text-xs ${MUTED}`}>No open order of this amount</span>}
                          <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ id: p.id, action: "not_order" })}
                            title="The money stays as it is. It just leaves this list.">Not an order payment</Button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
      </CardContent>
    </Card>
  );
}
