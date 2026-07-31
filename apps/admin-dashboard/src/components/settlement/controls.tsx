"use client";

// Shared settlement controls used by the Downline, Upline, and Admin settlement views:
//   <SettlementActionBar> — renders ONLY the status actions valid for this role at this
//                           status (from lib/settlement-fsm), collects any mandatory data,
//                           and POSTs the transition. UI and server share the FSM, so the
//                           buttons shown can never disagree with what the API accepts.
//   <SettlementTimeline>  — the immutable status history (who moved it, when, why).

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { allowedActions, type SettleRole, type SettleMode, type TransitionDef } from "@/lib/settlement-fsm";
import { settlementStatusVariant, settlementStatusLabel } from "@/components/settlement/status";
import { formatDateTime } from "@/lib/utils";

const FIELD_LABEL: Record<string, string> = {
  reason: "Reason", paid_amount: "Amount paid", payment_mode: "Payment mode",
  payment_date: "Payment date", utr: "UTR / RRN", source_bank: "Source bank account",
  tx_hash: "Transaction hash", usdt_quantity: "USDT quantity", usdt_rate: "Applied rate (₹/USDT)",
  expected_completion_date: "Expected completion date", error_code: "Bank response / error code",
  new_branch: "New branch code",
};
const DATE_FIELDS = new Set(["payment_date", "expected_completion_date"]);
const MODE_OPTIONS = ["IMPS", "RTGS", "NEFT", "UPI"];

const btnVariant = (v?: string) =>
  v === "danger" ? "destructive" : v === "warning" ? "secondary" : v === "primary" ? "default" : "secondary";

export function SettlementActionBar({
  settlementId, status, role, mode = "BANK", locked = false, prefill, onDone,
}: { settlementId: string; status: string; role: SettleRole; mode?: SettleMode; locked?: boolean; prefill?: Record<string, string>; onDone?: () => void }) {
  const qc = useQueryClient();
  const acts = allowedActions(status, role, mode, locked);
  const [open, setOpen] = useState<TransitionDef | null>(null);
  const [details, setDetails] = useState<Record<string, string>>({});
  const [remarks, setRemarks] = useState("");

  const run = useMutation({
    mutationFn: async (t: TransitionDef) => {
      const r = await fetch(`/api/settlements/${settlementId}/transition`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: t.action, remarks: remarks || undefined, details }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as { to: string };
    },
    onSuccess: (d) => {
      toast.success(`Updated → ${settlementStatusLabel(d.to)}`);
      setOpen(null); setDetails({}); setRemarks("");
      qc.invalidateQueries({ queryKey: ["settlements"] });
      qc.invalidateQueries({ queryKey: ["settlement-timeline", settlementId] });
      onDone?.();
    },
    onError: (e: Error) => toast.error("Couldn’t update", { description: e.message }),
  });

  if (!acts.length) return null;

  const missing = (t: TransitionDef) =>
    (t.requires ?? []).some((f) => !(details[f] && String(details[f]).trim()));

  const click = (t: TransitionDef) => {
    if ((t.requires?.length ?? 0) === 0) run.mutate(t);
    else {
      // Prefill known values (e.g. the locked USDT quantity/rate) so the downline
      // only has to add what's genuinely new — typically just the tx hash.
      const seeded: Record<string, string> = {};
      for (const f of t.requires ?? []) if (prefill?.[f]) seeded[f] = prefill[f];
      setDetails(seeded); setRemarks(""); setOpen(t);
    }
  };

  return (
    <div className="flex flex-wrap gap-1.5">
      {acts.map((t) => (
        <Button key={t.action} size="sm" variant={btnVariant(t.variant) as never}
          disabled={run.isPending} onClick={() => click(t)}>{t.label}</Button>
      ))}

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{open?.label}</DialogTitle>
            <DialogDescription>Provide the required details to continue.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {[...(open?.requires ?? []), ...(open?.optional ?? [])].map((f) => (
              <div key={f}>
                <Label className="text-xs">{FIELD_LABEL[f] ?? f}{(open?.optional ?? []).includes(f) ? " (optional)" : ""}</Label>
                {f === "payment_mode" ? (
                  <select className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
                    value={details[f] ?? ""} onChange={(e) => setDetails((d) => ({ ...d, [f]: e.target.value }))}>
                    <option value="">Select…</option>
                    {MODE_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <Input type={f === "paid_amount" ? "number" : DATE_FIELDS.has(f) ? "date" : "text"}
                    value={details[f] ?? ""} onChange={(e) => setDetails((d) => ({ ...d, [f]: e.target.value }))} />
                )}
              </div>
            ))}
            {!(open?.requires ?? []).includes("reason") && (
              <div><Label className="text-xs">Remarks (optional)</Label>
                <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
            )}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(null)}>Cancel</Button>
            <Button variant={btnVariant(open?.variant) as never}
              disabled={!open || run.isPending || missing(open)} onClick={() => open && run.mutate(open)}>
              {open?.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Downline uploads the bank receipt / USDT transfer proof (PNG/JPEG/WEBP/PDF).
export function UploadReceiptButton({ settlementId, onDone }: { settlementId: string; onDone?: () => void }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`/api/settlements/${settlementId}/receipt`, { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      toast.success("Receipt uploaded");
      qc.invalidateQueries({ queryKey: ["settlements"] });
      qc.invalidateQueries({ queryKey: ["settlement-timeline", settlementId] });
      onDone?.();
    } catch (e) { toast.error("Couldn’t upload", { description: (e as Error).message }); }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = ""; }
  };
  return (
    <>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? "Uploading…" : "Upload receipt"}
      </Button>
    </>
  );
}

interface NotifEv {
  id: string; settlement_id: string; action: string; from_status: string | null; to_status: string;
  actor: string | null; actor_role: string | null; remarks: string | null; created_at: string;
  request_ref: string | null; merchant_key: string; net_amount: number | null; amount: number | null;
  settle_mode: string | null; utr: string | null; tx_hash: string | null;
}

// Live settlement activity feed (BRD §7 dashboard notifications). Polls with the page
// and TOASTS events performed by the OTHER side as they land — e.g. the upline sees
// "KTN-SET-000245 marked Paid · UTR …" seconds after the downline acts.
export function SettlementNotifications({ selfRole }: { selfRole: SettleRole }) {
  const lastSeen = useRef<string | null>(null);
  const q = useQuery({
    queryKey: ["settlement-notifications"],
    queryFn: async () => (await fetch("/api/settlements/notifications").then((r) => r.json())) as { events: NotifEv[] },
    refetchInterval: 10_000,
  });
  const events = q.data?.events ?? [];

  // Toast anything newer than the last seen event that the OTHER role performed.
  if (events.length) {
    const newestId = events[0].id;
    if (lastSeen.current && newestId !== lastSeen.current) {
      const fresh: NotifEv[] = [];
      for (const e of events) { if (e.id === lastSeen.current) break; fresh.push(e); }
      for (const e of fresh.reverse()) {
        if (e.actor_role === selfRole) continue;
        const amt = e.net_amount ?? e.amount;
        toast.info(`${e.request_ref ?? "Settlement"} → ${settlementStatusLabel(e.to_status)}`, {
          description: `${amt != null ? `₹${amt}` : ""}${e.utr ? ` · UTR ${e.utr}` : ""}${e.tx_hash ? ` · hash ${String(e.tx_hash).slice(0, 14)}…` : ""} · by ${e.actor_role?.toLowerCase() ?? "system"}`,
        });
      }
    }
    lastSeen.current = newestId;
  }

  if (!events.length) return null;
  return (
    <div className="max-h-64 overflow-auto rounded-md border">
      {events.slice(0, 12).map((e) => (
        <div key={e.id} className="flex items-center gap-2 border-b px-3 py-2 text-xs last:border-b-0">
          <Badge variant={settlementStatusVariant(e.to_status)}>{settlementStatusLabel(e.to_status)}</Badge>
          <span className="font-mono">{e.request_ref ?? e.settlement_id.slice(0, 8)}</span>
          <span className="flex-1 truncate text-[color:var(--color-text-muted)]">
            {(e.net_amount ?? e.amount) != null ? `₹${e.net_amount ?? e.amount}` : ""}{e.remarks ? ` · ${e.remarks}` : ""}
          </span>
          <span className="text-[color:var(--color-text-muted)]">{e.actor_role?.toLowerCase()}</span>
          <span className="tabular-nums text-[color:var(--color-text-muted)]">{formatDateTime(e.created_at)}</span>
        </div>
      ))}
    </div>
  );
}

interface Ev {
  id: string; action: string; from_status: string | null; to_status: string;
  actor: string | null; actor_role: string | null; remarks: string | null;
  details: Record<string, unknown>; created_at: string;
}

export function SettlementTimeline({ settlementId }: { settlementId: string }) {
  const q = useQuery({
    queryKey: ["settlement-timeline", settlementId],
    queryFn: async () => (await fetch(`/api/settlements/${settlementId}/timeline`).then((r) => r.json())) as { events: Ev[] },
    refetchInterval: 10_000,
  });
  const events = q.data?.events ?? [];
  if (q.isLoading) return <div className="text-xs text-[color:var(--color-text-muted)]">Loading timeline…</div>;
  if (!events.length) return <div className="text-xs text-[color:var(--color-text-muted)]">No status changes yet.</div>;
  return (
    <ol className="space-y-3">
      {events.map((e) => (
        <li key={e.id} className="flex gap-3">
          <div className="mt-1 flex flex-col items-center">
            <span className="h-2 w-2 rounded-full bg-[color:var(--color-brand,#35E9D8)]" />
            <span className="mt-1 w-px flex-1 bg-[color:var(--color-outline,#1E2C44)]" />
          </div>
          <div className="flex-1 pb-1">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={settlementStatusVariant(e.to_status)}>{settlementStatusLabel(e.to_status)}</Badge>
              {e.from_status ? <span className="text-xs text-[color:var(--color-text-muted)]">from {settlementStatusLabel(e.from_status)}</span> : null}
            </div>
            <div className="text-xs text-[color:var(--color-text-muted)]">
              {e.actor ?? "—"}{e.actor_role ? ` · ${e.actor_role.toLowerCase()}` : ""} · {formatDateTime(e.created_at)}
            </div>
            {e.remarks ? <div className="mt-0.5 text-xs">{e.remarks}</div> : null}
            {typeof e.details?.utr === "string" ? <div className="mt-0.5 text-xs font-mono">UTR {e.details.utr as string}</div> : null}
            {typeof e.details?.tx_hash === "string" ? <div className="mt-0.5 break-all text-xs font-mono">Hash {e.details.tx_hash as string}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
