"use client";

// Settlement Engine (staff): per banker, what it owes its merchant on the ledger, the settlement
// config (versioned, two-person), and the settlements the engine raised and followed. The banker
// still pays and the merchant still verifies in the screens they use; this page shows the engine's
// side. API: /api/settlement-engine.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, Pause, Play, RefreshCw, Send } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/utils";
import { useAccess } from "@/lib/use-access";

type Timing = "INSTANT" | "ON_DEMAND" | "T0" | "T1" | "T2" | "WEEKLY";
interface Body {
  timing: Timing; weekday?: number | null; run_hour_ist?: number | null; currency: "INR";
  min_payout_minor: number; max_payout_minor?: number | null; reserve_bps: number; reserve_hold_days: number; tds_bps: number;
  beneficiary_id: string | null; transfer_mode: "IMPS" | "NEFT" | "RTGS" | "UPI"; allow_on_demand?: boolean;
}
interface Config { id: string; version: number; state: string; body: Body; maker: string; maker_note: string | null; checker: string | null; created_at: string; decided_at: string | null }
interface Event { from_state: string | null; to_state: string; actor: string | null; reason: string | null; at: string }
interface Instruction {
  id: string; kind: string; cycle_key: string | null; state: string; gross_minor: string; reserve_minor: string;
  upline_minor: string; katana_minor: string; downline_minor: string; fixed_minor: string; gst_minor: string; tds_minor: string; net_minor: string;
  utr: string | null; created_at: string; config_version: number | null; events?: Event[];
}
interface View {
  banker: string; provider_id: string | null; paused: boolean;
  balances: { payable: string; reserve: string; in_transit: string; held_by_banker: string };
  config: Config | null; pending: Config | null; history?: Config[];
  beneficiaries: { id: string; label: string; name: string; bank: string | null; mode: string; account: string | null; vpa: string | null }[];
  instructions: Instruction[];
}

const MUTED = "text-[color:var(--color-text-muted)]";
const inr = (paise: string | number | bigint) => `₹${(Number(paise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TIMING_LABEL: Record<Timing, string> = { INSTANT: "Instant", ON_DEMAND: "On demand only", T0: "T+0 (same day)", T1: "T+1", T2: "T+2", WEEKLY: "Weekly" };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const STATE_VARIANT: Record<string, "success" | "warning" | "danger" | "info" | "default"> = {
  SETTLED: "success", IN_TRANSIT: "info", INITIATED: "info", PENDING: "default", HELD: "warning", FAILED: "danger", REVERSED: "danger", CANCELLED: "default",
};

async function api<T>(body?: unknown, banker?: string): Promise<T> {
  const r = await fetch(body ? "/api/settlement-engine" : `/api/settlement-engine${banker ? `?banker=${encodeURIComponent(banker)}` : ""}`,
    body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d as T;
}

function describe(b: Body): string {
  const when = b.timing === "WEEKLY" ? `Weekly on ${DAYS[b.weekday ?? 1]}` : TIMING_LABEL[b.timing];
  const parts = [when, `by ${b.transfer_mode}`, `min ${inr(b.min_payout_minor)}`];
  if (b.max_payout_minor) parts.push(`max ${inr(b.max_payout_minor)}`);
  if (b.reserve_bps) parts.push(`reserve ${b.reserve_bps / 100}% for ${b.reserve_hold_days} days`);
  if (b.tds_bps) parts.push(`TDS ${b.tds_bps / 100}%`);
  if (b.allow_on_demand && b.timing !== "ON_DEMAND") parts.push("on-demand allowed");
  return parts.join(" · ");
}

export default function SettlementEnginePage() {
  const qc = useQueryClient();
  const persona = useAccess().data?.persona;
  const canWrite = persona === "SUPER_ADMIN" || persona === "ADMIN" || persona === "FINANCE";
  const list = useQuery({ queryKey: ["se:list"], queryFn: () => api<{ bankers: { code: string; name: string; config: { state: string; version: number; timing: string } | null }[] }>() });
  const [banker, setBanker] = useState("");
  const [filter, setFilter] = useState("");
  useEffect(() => { const b = new URLSearchParams(window.location.search).get("banker"); if (b) setBanker(b); }, []);
  const view = useQuery({ queryKey: ["se:banker", banker], queryFn: () => api<View>(undefined, banker), enabled: !!banker, refetchInterval: 30_000 });
  const v = view.data;

  const act = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Record<string, unknown>>(body),
    onSuccess: (_d, body) => {
      toast.success(({ propose: "Change sent for approval", decide: "Decision recorded", pause: "Settlement paused", resume: "Settlement resumed", raise: "Settlement raised", cancel: "Settlement cancelled", run: "Engine run done" } as Record<string, string>)[String(body.action)] ?? "Done");
      qc.invalidateQueries({ queryKey: ["se:banker"] }); qc.invalidateQueries({ queryKey: ["se:list"] });
    },
    onError: (e: Error) => toast.error("Not done", { description: e.message, duration: 10000 }),
  });

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (list.data?.bankers ?? []).filter((b) => !f || b.code.toLowerCase().includes(f) || b.name.toLowerCase().includes(f)).slice(0, 200);
  }, [list.data, filter]);

  return (
    <div className="space-y-4">
      <PageHeader title="Settlement Engine" icon={Banknote}
        description="What each banker owes its merchant on the ledger, how and when it is settled, and every settlement the engine raised. Bankers still pay and merchants still verify in their own screens." />

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div className="min-w-[260px] flex-1 space-y-1.5">
            <Label htmlFor="se-find">Banker</Label>
            <Input id="se-find" placeholder="Search by code or name" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <select className="h-9 min-w-[280px] flex-1 rounded-md border bg-[color:var(--color-surface)] px-3 text-sm" value={banker}
            onChange={(e) => { setBanker(e.target.value); const u = new URL(window.location.href); u.searchParams.set("banker", e.target.value); window.history.replaceState(null, "", u); }}>
            <option value="">Choose a banker…</option>
            {shown.map((b) => <option key={b.code} value={b.code}>{b.code} — {b.name}{b.config ? ` (${b.config.state === "ACTIVE" ? TIMING_LABEL[b.config.timing as Timing] ?? b.config.timing : "change waiting"})` : ""}</option>)}
          </select>
          {persona === "SUPER_ADMIN" && (
            <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ action: "run" })}><RefreshCw className="h-4 w-4" /> Run engine now</Button>
          )}
        </CardContent>
      </Card>

      {!banker ? <p className={`text-sm ${MUTED}`}>Choose a banker to see its balances, settlement config and settlements.</p>
        : view.isLoading ? <p className={`text-sm ${MUTED}`}>Loading…</p>
        : view.error ? <p className="text-sm text-[color:var(--color-danger)]">{(view.error as Error).message}</p>
        : v && <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {([
              ["Payable to merchant", v.balances.payable, "Collected, not yet raised for settlement"],
              ["Reserve held", v.balances.reserve, "Withheld from settlements until released"],
              ["In transit", v.balances.in_transit, "Raised to the banker, not yet verified"],
              ["Held by banker", v.balances.held_by_banker, "Merchants' money with the banker"],
            ] as const).map(([t, val, hint]) => (
              <Card key={t}><CardContent className="pt-5">
                <div className={`text-xs ${MUTED}`}>{t}</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">{inr(val)}</div>
                <div className={`mt-1 text-xs ${MUTED}`}>{hint}</div>
              </CardContent></Card>
            ))}
          </div>

          <ConfigCard v={v} canWrite={canWrite} busy={act.isPending} act={(b) => act.mutate(b)} />

          <Card>
            <CardHeader className="flex-row items-start justify-between space-y-0">
              <div>
                <CardTitle className="text-base">Settlements</CardTitle>
                <CardDescription>Newest first. Each one raised a settlement request the banker pays and the merchant verifies.</CardDescription>
              </div>
              {canWrite && <RaiseNow banker={v.banker} disabled={!v.config || v.paused || act.isPending} act={(b) => act.mutate(b)} />}
            </CardHeader>
            <CardContent>
              {!v.instructions.length ? <p className={`py-4 text-center text-sm ${MUTED}`}>No settlements yet.</p> : (
                <ul className="divide-y rounded-md border">
                  {v.instructions.map((i) => (
                    <li key={i.id} className="space-y-1.5 px-3 py-2.5 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={STATE_VARIANT[i.state] ?? "default"}>{i.state.replace("_", " ")}</Badge>
                        <span className="font-medium tabular-nums">{inr(i.net_minor)}</span>
                        <span className={`text-xs ${MUTED}`}>net of {inr(i.gross_minor)}</span>
                        <Badge variant="default">{i.kind === "SCHEDULED" ? i.cycle_key ?? "scheduled" : i.kind.replace("_", " ").toLowerCase()}</Badge>
                        {i.utr && <span className="font-mono text-xs">UTR {i.utr}</span>}
                        <span className={`ml-auto text-xs ${MUTED}`}>{formatDateTime(i.created_at)}{i.config_version ? ` · config v${i.config_version}` : ""}</span>
                        {canWrite && (i.state === "PENDING" || i.state === "HELD") && (
                          <Button size="sm" variant="ghost" onClick={() => { const r = window.prompt("Why cancel this settlement?"); if (r && r.trim().length >= 3) act.mutate({ action: "cancel", instruction_id: i.id, reason: r.trim() }); }}>Cancel</Button>
                        )}
                      </div>
                      <div className={`text-xs ${MUTED}`}>
                        Charges {inr(BigInt(i.upline_minor) + BigInt(i.katana_minor) + BigInt(i.downline_minor) + BigInt(i.fixed_minor))} · GST {inr(i.gst_minor)} · TDS kept by merchant {inr(i.tds_minor)} · reserve {inr(i.reserve_minor)}
                      </div>
                      {i.events?.length ? (
                        <div className={`text-xs ${MUTED}`}>
                          {i.events.map((e, n) => <span key={n}>{n ? " → " : ""}{e.to_state.replace("_", " ").toLowerCase()} <span title={e.reason ?? ""}>({formatDateTime(e.at)}{e.actor ? `, ${e.actor}` : ""})</span></span>)}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>}
    </div>
  );
}

function RaiseNow({ banker, disabled, act }: { banker: string; disabled: boolean; act: (b: Record<string, unknown>) => void }) {
  const [amount, setAmount] = useState("");
  return (
    <div className="flex items-center gap-2">
      <Input className="h-8 w-36" placeholder="₹ (blank = all)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <Button size="sm" disabled={disabled} onClick={() => {
        const rupees = amount.trim() ? Number(amount) : null;
        if (rupees != null && !(rupees > 0)) { toast.error("Enter an amount in rupees, or leave it blank"); return; }
        if (!window.confirm(`Raise a settlement now for ${banker}${rupees ? ` of ₹${rupees}` : " of everything available"}?`)) return;
        act({ action: "raise", banker, key: `staff-${Date.now()}`, ...(rupees ? { amount_minor: Math.round(rupees * 100) } : {}) });
        setAmount("");
      }}><Send className="h-3.5 w-3.5" /> Settle now</Button>
    </div>
  );
}

function ConfigCard({ v, canWrite, busy, act }: { v: View; canWrite: boolean; busy: boolean; act: (b: Record<string, unknown>) => void }) {
  const base: Body = v.pending?.body ?? v.config?.body ?? {
    timing: "T1", run_hour_ist: 10, currency: "INR", min_payout_minor: 100_00, max_payout_minor: null,
    reserve_bps: 0, reserve_hold_days: 0, tds_bps: 0, beneficiary_id: v.beneficiaries[0]?.id ?? null, transfer_mode: "IMPS", allow_on_demand: false,
  };
  const [f, setF] = useState(() => ({
    timing: base.timing, weekday: String(base.weekday ?? 1), run_hour_ist: String(base.run_hour_ist ?? (base.timing === "T0" ? 22 : 10)),
    min: String(base.min_payout_minor / 100), max: base.max_payout_minor ? String(base.max_payout_minor / 100) : "",
    reserve: String(base.reserve_bps / 100), hold: String(base.reserve_hold_days), tds: String(base.tds_bps / 100),
    beneficiary_id: base.beneficiary_id ?? "", transfer_mode: base.transfer_mode, allow_on_demand: !!base.allow_on_demand, note: "",
  }));
  const [editing, setEditing] = useState(false);
  const propose = () => {
    const body: Body = {
      timing: f.timing, weekday: f.timing === "WEEKLY" ? Number(f.weekday) : null, run_hour_ist: Number(f.run_hour_ist), currency: "INR",
      min_payout_minor: Math.round(Number(f.min || 0) * 100), max_payout_minor: f.max ? Math.round(Number(f.max) * 100) : null,
      reserve_bps: Math.round(Number(f.reserve || 0) * 100), reserve_hold_days: Number(f.hold || 0), tds_bps: Math.round(Number(f.tds || 0) * 100),
      beneficiary_id: f.beneficiary_id || null, transfer_mode: f.transfer_mode, allow_on_demand: f.allow_on_demand,
    };
    act({ action: "propose", banker: v.banker, body, note: f.note || undefined });
    setEditing(false);
  };
  const sel = "h-9 w-full rounded-md border bg-[color:var(--color-surface)] px-3 text-sm";
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Settlement config</CardTitle>
          <CardDescription>Every change is a new version and needs a second person to approve it.</CardDescription>
        </div>
        {canWrite && (
          <div className="flex gap-2">
            {v.paused
              ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => act({ action: "resume", banker: v.banker })}><Play className="h-3.5 w-3.5" /> Resume</Button>
              : <Button size="sm" variant="secondary" disabled={busy} onClick={() => { const r = window.prompt("Why pause settlement for this banker?"); if (r && r.trim().length >= 3) act({ action: "pause", banker: v.banker, reason: r.trim() }); }}><Pause className="h-3.5 w-3.5" /> Pause</Button>}
            {!v.pending && <Button size="sm" disabled={busy} onClick={() => setEditing((x) => !x)}>{editing ? "Close" : v.config ? "Propose a change" : "Set up settlement"}</Button>}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {v.paused && <div className="rounded-md border border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning-muted)] px-3 py-2">Settlement is paused for this banker: no cycle raises anything until it is resumed.</div>}
        {v.config ? (
          <div><Badge variant="success">Active v{v.config.version}</Badge> <span className="ml-1">{describe(v.config.body)}</span>
            <div className={`mt-1 text-xs ${MUTED}`}>Proposed by {v.config.maker}, approved by {v.config.checker}{v.config.decided_at ? ` on ${formatDateTime(v.config.decided_at)}` : ""}. Pays to {v.beneficiaries.find((b) => b.id === v.config!.body.beneficiary_id)?.label ?? "an account that is no longer active"}.</div>
          </div>
        ) : <p className={MUTED}>No approved config: nothing is settled automatically for this banker.</p>}
        {v.pending && (
          <div className="rounded-md border p-3">
            <div><Badge variant="warning">Waiting for approval · v{v.pending.version}</Badge> <span className="ml-1">{describe(v.pending.body)}</span></div>
            <div className={`mt-1 text-xs ${MUTED}`}>Proposed by {v.pending.maker} on {formatDateTime(v.pending.created_at)}{v.pending.maker_note ? `: “${v.pending.maker_note}”` : ""}. The proposer cannot approve it.</div>
            {canWrite && (
              <div className="mt-2 flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => act({ action: "decide", config_id: v.pending!.id, approve: true })}>Approve</Button>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => { const r = window.prompt("Why reject?") ?? ""; act({ action: "decide", config_id: v.pending!.id, approve: false, note: r || undefined }); }}>Reject</Button>
              </div>
            )}
          </div>
        )}
        {editing && (
          <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5"><Label>When</Label>
              <select className={sel} value={f.timing} onChange={(e) => setF({ ...f, timing: e.target.value as Timing })}>
                {(Object.keys(TIMING_LABEL) as Timing[]).map((t) => <option key={t} value={t}>{TIMING_LABEL[t]}</option>)}
              </select></div>
            {f.timing === "WEEKLY" && <div className="space-y-1.5"><Label>Weekday</Label>
              <select className={sel} value={f.weekday} onChange={(e) => setF({ ...f, weekday: e.target.value })}>{DAYS.map((d, n) => <option key={d} value={n}>{d}</option>)}</select></div>}
            {["T0", "T1", "T2", "WEEKLY"].includes(f.timing) && <div className="space-y-1.5"><Label>{f.timing === "T0" ? "Cut-off hour (IST)" : "Run from hour (IST)"}</Label>
              <Input type="number" min="0" max="23" value={f.run_hour_ist} onChange={(e) => setF({ ...f, run_hour_ist: e.target.value })} /></div>}
            <div className="space-y-1.5"><Label>Transfer</Label>
              <select className={sel} value={f.transfer_mode} onChange={(e) => setF({ ...f, transfer_mode: e.target.value as Body["transfer_mode"] })}>{["IMPS", "NEFT", "RTGS", "UPI"].map((m) => <option key={m}>{m}</option>)}</select></div>
            <div className="space-y-1.5"><Label>Minimum payout (₹)</Label><Input inputMode="decimal" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Maximum per cycle (₹, blank = none)</Label><Input inputMode="decimal" value={f.max} onChange={(e) => setF({ ...f, max: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Rolling reserve (%)</Label><Input inputMode="decimal" value={f.reserve} onChange={(e) => setF({ ...f, reserve: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Reserve held (days)</Label><Input type="number" min="0" value={f.hold} onChange={(e) => setF({ ...f, hold: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>TDS the merchant withholds (%)</Label><Input inputMode="decimal" value={f.tds} onChange={(e) => setF({ ...f, tds: e.target.value })} /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label>Pay to</Label>
              <select className={sel} value={f.beneficiary_id} onChange={(e) => setF({ ...f, beneficiary_id: e.target.value })}>
                <option value="">Choose the merchant's account…</option>
                {v.beneficiaries.map((b) => <option key={b.id} value={b.id}>{b.label} — {b.name}{b.bank ? `, ${b.bank}` : ""} {b.account ?? b.vpa ?? ""}</option>)}
              </select>
              {!v.beneficiaries.length && <p className={`text-xs ${MUTED}`}>The merchant has no active payout account yet: it adds one under its Settlements page.</p>}</div>
            <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={f.allow_on_demand} onChange={(e) => setF({ ...f, allow_on_demand: e.target.checked })} /> Allow on-demand payouts too</label>
            <div className="space-y-1.5 sm:col-span-2 lg:col-span-3"><Label>Note for the approver</Label><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Why this change" /></div>
            <div className="flex items-end"><Button disabled={busy || !f.beneficiary_id} onClick={propose}>Send for approval</Button></div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
