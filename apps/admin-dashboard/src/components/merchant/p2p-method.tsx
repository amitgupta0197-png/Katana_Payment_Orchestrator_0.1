"use client";

// The staff banker page's "Pays UPI ID" tab, step 1: how this banker is paid on P2P — its UPI ID,
// BharatPe, or PayAtom — exactly one at a time (lib/p2p-method, /api/merchants/{id}/p2p-method).
// Below the choice, only the chosen method's setup is shown (passed in as `setup`), with a
// checklist that ticks itself from what is really saved. Switching asks first and says what
// changes; the old method's setup is kept, just not used. Staff only (it names processors).

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Circle, Link2, QrCode, Smartphone } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { P2P_APP_INFO, P2P_METHOD_INFO, P2P_METHODS, switchSummary, type P2pApp, type P2pFacts, type P2pMethod, type P2pStep } from "@/lib/p2p-method";

interface P2pState {
  method: P2pMethod | null;
  app: P2pApp | null;
  inferred: P2pMethod | null;
  facts: P2pFacts;
  methods: Record<P2pMethod, { steps: P2pStep[]; ready: boolean }>;
  history: { from_method: string | null; to_method: string | null; changed_by: string | null; note: string | null; changed_at: string }[];
}

const ICON: Record<P2pMethod, typeof Smartphone> = { UPI_ID: Smartphone, BHARATPE: QrCode, PAYATOM: Link2 };
const muted = "text-[color:var(--color-text-muted)]";

export function P2pMethodPanel({ merchantId, canEdit, setup }: {
  merchantId: string;
  canEdit: boolean;
  /** Each method's own setup cards; only the chosen one is shown. */
  setup: Record<P2pMethod, ReactNode>;
}) {
  const qc = useQueryClient();
  const key = ["merchant", merchantId, "p2p-method"];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/p2p-method`);
      if (r.status === 403) return null;
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as P2pState;
    },
    refetchInterval: 30_000,
  });
  const [asking, setAsking] = useState<P2pMethod | null>(null);
  const [note, setNote] = useState("");
  const saveApp = useMutation({
    mutationFn: async (app: P2pApp | null) => {
      const r = await fetch(`/api/merchants/${merchantId}/p2p-method`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "UPI_ID", app }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as P2pState;
    },
    onSuccess: (d) => { qc.setQueryData(key, d); toast.success(d.app ? `QR app: ${P2P_APP_INFO[d.app].title}` : "QR app cleared"); },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });
  const save = useMutation({
    mutationFn: async (method: P2pMethod) => {
      const r = await fetch(`/api/merchants/${merchantId}/p2p-method`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, note: note.trim() || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as P2pState;
    },
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      qc.invalidateQueries({ queryKey: ["merchant", merchantId] });
      toast.success(`P2P payments now go through ${P2P_METHOD_INFO[d.method!].title}`);
      setAsking(null); setNote("");
    },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });

  if (q.data === null) return null;
  const d = q.data;
  const chosen = d?.method ?? null;
  // What to show below the choice: the chosen method, else what routing uses today.
  const shown = chosen ?? d?.inferred ?? null;

  const status = (m: P2pMethod) => {
    if (!d) return null;
    if (chosen === m) return d.methods[m].ready ? <Badge variant="success">In use</Badge> : <Badge variant="warning">In use · set up needed</Badge>;
    if (!chosen && d.inferred === m) return <Badge variant="info">Used today</Badge>;
    return d.methods[m].ready ? <Badge>Set up, not in use</Badge> : null;
  };

  return (
    <>
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">How this banker gets P2P payments</CardTitle>
          <CardDescription>Pick one. Only the chosen method takes P2P orders; the others stay saved but unused.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {d && !chosen && (
            <div className="rounded-lg border border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning-muted)] px-3 py-2 text-xs">
              Nothing chosen yet. {d.inferred
                ? <>P2P orders go to <b>{P2P_METHOD_INFO[d.inferred].title}</b> today, by the old rule. Choose it to keep it, or pick another.</>
                : <>Nothing is set up for P2P, so live P2P orders are refused. Choose a method to start.</>}
            </div>
          )}
          <div role="radiogroup" aria-label="P2P method" className="grid gap-2 md:grid-cols-3">
            {P2P_METHODS.map((m) => {
              const info = P2P_METHOD_INFO[m];
              const Icon = ICON[m];
              const sel = chosen === m;
              return (
                <button key={m} type="button" role="radio" aria-checked={sel}
                  disabled={!canEdit || !d || save.isPending}
                  onClick={() => { if (!sel) setAsking(m); }}
                  className={`flex flex-col gap-2 rounded-xl border p-3 text-left transition-colors disabled:cursor-default ${sel
                    ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)]"
                    : "border-[color:var(--color-border)] enabled:hover:border-[color:var(--color-text-muted)]"}`}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-medium">
                      <span className={`grid size-7 place-items-center rounded-lg ${sel ? "bg-[color:var(--color-brand)] text-white" : "bg-[color:var(--color-surface-muted)]"}`}>
                        <Icon className="size-4" />
                      </span>
                      {info.title}
                    </span>
                    {status(m)}
                  </span>
                  <span className="text-xs">{info.line}</span>
                  <span className={`text-xs ${muted}`}>{info.confirmedBy}</span>
                </button>
              );
            })}
          </div>
          {!canEdit && <p className={`text-xs ${muted}`}>Only a Super Admin or Admin can change this.</p>}
          {d?.history?.[0] && (
            <p className={`text-xs ${muted}`}>
              Last changed {new Date(d.history[0].changed_at).toLocaleString("en-IN")}
              {d.history[0].changed_by ? ` by ${d.history[0].changed_by}` : ""}
              {d.history[0].note ? ` — “${d.history[0].note}”` : ""}.
            </p>
          )}
        </CardContent>
      </Card>

      {d && shown && (
        <div className="mb-4">
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-[color:var(--color-border)] px-4 py-3">
            <span className="text-sm font-medium">Set up {P2P_METHOD_INFO[shown].title}</span>
            {chosen === "UPI_ID" && (
              <label className="flex items-center gap-1.5 text-xs">
                <span className={muted}>QR app</span>
                <select value={d.app && d.app !== "BHARATPE" ? d.app : ""} disabled={!canEdit || saveApp.isPending}
                  onChange={(e) => saveApp.mutate((e.target.value || null) as P2pApp | null)}
                  className="h-7 rounded-md border bg-[color:var(--color-surface)] px-2 text-xs">
                  <option value="">Not recorded</option>
                  {(["GPAY", "PHONEPE", "PAYTM", "OTHER"] as P2pApp[]).map((x) => <option key={x} value={x}>{P2P_APP_INFO[x].title}</option>)}
                </select>
              </label>
            )}
            {d.methods[shown].steps.map((s) => (
              <span key={s.key} className={`flex items-center gap-1.5 text-xs ${s.done ? "" : muted}`}>
                {s.done
                  ? <Check className="size-3.5 text-[color:var(--color-success)]" />
                  : <Circle className={`size-3.5 ${s.required ? "text-[color:var(--color-warning)]" : ""}`} />}
                {s.label}{!s.required && !s.done ? " (recommended)" : ""}
              </span>
            ))}
            <span className="ml-auto">
              {d.methods[shown].ready
                ? <Badge variant="success">Ready for live P2P</Badge>
                : <Badge variant="warning">Not ready: live P2P orders are refused</Badge>}
            </span>
          </div>
          {setup[shown]}
        </div>
      )}

      <Dialog open={asking !== null} onOpenChange={(o) => { if (!o) { setAsking(null); setNote(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{asking ? `Use ${P2P_METHOD_INFO[asking].title} for P2P?` : ""}</DialogTitle>
            <DialogDescription>{asking ? P2P_METHOD_INFO[asking].line : ""}</DialogDescription>
          </DialogHeader>
          {asking && d && (
            <div className="space-y-3 text-sm">
              <ul className="list-disc space-y-1 pl-5">
                {switchSummary(chosen, asking, d.facts).map((l) => <li key={l}>{l}</li>)}
              </ul>
              <div className="space-y-1">
                <Label htmlFor="p2p-note">Note <span className={muted}>(optional)</span></Label>
                <Input id="p2p-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why the change" maxLength={300} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setAsking(null); setNote(""); }}>Keep {chosen ? P2P_METHOD_INFO[chosen].title : "as is"}</Button>
            <Button disabled={save.isPending} onClick={() => asking && save.mutate(asking)}>
              {save.isPending ? "Saving…" : asking ? `Use ${P2P_METHOD_INFO[asking].title}` : "Use"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
