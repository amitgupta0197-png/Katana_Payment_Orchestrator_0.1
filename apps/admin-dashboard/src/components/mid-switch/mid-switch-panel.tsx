"use client";

// The MID switch (lib/mid-switch) for one banker: which of its own MIDs takes pay-in traffic, each
// MID's limits, hours and health, the manual switch, and the log of every change and automatic
// switch. One component for the merchant portal, the banker portal and staff (/api/mid-switch
// decides what each may see and change; a merchant never sees a processor's name).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Pause, Pencil, Play, Plus, Zap } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn, formatAmount, formatDateTime } from "@/lib/utils";
import { MID_KIND_LABEL, type MidKind, type MidMode } from "@/lib/mid-switch";
import type { MidViewRow } from "@/lib/mid-switch-view";

interface KindSettings { enabled: boolean; mode: MidMode; pinned_mid_id: string | null; pinned_until: string | null; pin_reason: string | null; last_mid_id: string | null; in_use: boolean }
export interface SwitchDetail {
  banker: string; staff: boolean;
  settings: Record<MidKind, KindSettings>;
  mids: MidViewRow[];
  can_add: { UPI: string[]; GATEWAY: { vault_label: string; gateway: string; env: string; mid_code: string }[]; gateway_accounts_not_added: number };
  events: { at: string; kind: string | null; mid_id: string | null; action: string; who: string; text: string }[];
}

const send = async (body: Record<string, unknown>) => {
  const r = await fetch("/api/mid-switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d as SwitchDetail;
};
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const sel = "w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm";

export function MidSwitchPanel({ banker }: { banker: string }) {
  const qc = useQueryClient();
  const key = ["mid-switch", banker];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/mid-switch?banker=${encodeURIComponent(banker)}`);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
      return d as SwitchDetail;
    },
    refetchInterval: 20_000,
  });
  const act = useMutation({
    mutationFn: (body: Record<string, unknown>) => send({ banker, ...body }),
    onSuccess: (d) => { qc.setQueryData(key, d); toast.success("Saved"); },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });
  const [kind, setKind] = useState<MidKind>("UPI");
  const [edit, setEdit] = useState<MidViewRow | "new" | null>(null);
  const [pinFor, setPinFor] = useState<MidViewRow | null>(null);

  const d = q.data;
  if (q.isError) return <Card><CardContent className="py-6 text-center text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</CardContent></Card>;
  if (!d) return <Card><CardContent className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">Loading…</CardContent></Card>;

  const s = d.settings[kind];
  const mids = d.mids.filter((m) => m.kind === kind).sort((a, b) => a.priority - b.priority);
  const now = mids.find((m) => m.last_used);
  const pinned = mids.find((m) => m.pinned);
  const canAddGateway = d.staff && d.can_add.GATEWAY.length > 0;
  const canAdd = kind === "UPI" ? d.can_add.UPI.length > 0 : canAddGateway;
  const takers = mids.filter((m) => m.takes_traffic_now);

  return (
    <div className="space-y-4">
      <div role="tablist" className="inline-flex rounded-md border border-[color:var(--color-border)] p-0.5">
        {(["UPI", "GATEWAY"] as MidKind[]).map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
            className={cn("rounded px-3 py-1.5 text-sm font-medium", kind === k ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]" : "text-[color:var(--color-text-muted)]")}>
            {MID_KIND_LABEL[k]} <span className="text-xs">({d.mids.filter((m) => m.kind === k).length})</span>
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-6 text-sm">
          <div>
            <div className="flex items-center gap-1 text-xs text-[color:var(--color-text-muted)]">Taking traffic now <InfoTip label="the traffic switch">A banker can have several accounts. The switch decides which one takes each order, using limits, hours and health. It never moves money to another banker.</InfoTip></div>
            <div className="font-semibold">{!mids.length ? "Not set up: routed as before" : !s.enabled ? "Switch off: routed as before" : now ? now.name : takers[0]?.name ?? "No MID can take payments"}</div>
          </div>
          <div>
            <div className="text-xs text-[color:var(--color-text-muted)]">Can take payments now</div>
            <div className={cn("font-semibold", mids.length && !takers.length && "text-[color:var(--color-danger)]")}>{takers.length} of {mids.length}</div>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.enabled} disabled={act.isPending || !mids.length}
              onChange={(e) => act.mutate({ action: "settings", kind, enabled: e.target.checked })} />
            Switch on
          </label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[color:var(--color-text-muted)]">Rule</span>
            <div className="inline-flex rounded-md border border-[color:var(--color-border)] p-0.5">
              {(["PRIORITY", "WEIGHTED"] as MidMode[]).map((m) => (
                <button key={m} disabled={act.isPending} onClick={() => act.mutate({ action: "settings", kind, mode: m })}
                  className={cn("rounded px-2.5 py-1 text-xs font-medium", s.mode === m ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]" : "text-[color:var(--color-text-muted)]")}>
                  {m === "PRIORITY" ? "Priority, then next" : "Weighted split"}
                </button>
              ))}
            </div>
          </div>
          {pinned ? (
            <div className="flex items-center gap-2 rounded-md border border-[color:var(--color-warning)] px-2 py-1">
              <ArrowRightLeft className="h-4 w-4" />
              <span>Switched by hand to <b>{pinned.name}</b>{s.pinned_until ? ` until ${formatDateTime(s.pinned_until)}` : ""}</span>
              <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ action: "unpin", kind })}>Back to automatic</Button>
            </div>
          ) : null}
          <div className="ml-auto">
            {canAdd && <Button size="sm" onClick={() => setEdit("new")}><Plus className="h-4 w-4" /> Add {kind === "UPI" ? "UPI ID" : "account"}</Button>}
          </div>
        </CardContent>
      </Card>

      {kind === "GATEWAY" && !d.staff && d.can_add.gateway_accounts_not_added > 0 && (
        <p className="text-xs text-[color:var(--color-text-muted)]">Katana has {d.can_add.gateway_accounts_not_added} more processor account{d.can_add.gateway_accounts_not_added === 1 ? "" : "s"} for you that are not in the switch yet. Ask Katana support to add them.</p>
      )}

      {!mids.length ? (
        <Card><CardContent className="py-8 text-center text-sm text-[color:var(--color-text-muted)]">
          {kind === "UPI"
            ? d.can_add.UPI.length ? "Add your UPI IDs to share P2P traffic between them, with limits for each." : "Only one UPI ID is set up on this account. Ask Katana to add more, then add them here."
            : d.staff ? (canAddGateway ? "Add this banker's processor accounts to the switch." : "This banker has no further processor accounts. Add one on the banker's Pay-in gateway card (\"Add another account\").")
            : "Intent payments use your one processor account. Ask Katana support for more accounts to switch between."}
        </CardContent></Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {mids.map((m) => <MidCard key={m.id} m={m} mode={s.mode} staff={d.staff} busy={act.isPending}
            onEdit={() => setEdit(m)} onPin={() => setPinFor(m)}
            onPause={() => { const reason = window.prompt("Why pause it? (optional)") ?? undefined; act.mutate({ action: "pause", mid_id: m.id, reason }); }}
            onResume={() => act.mutate({ action: "resume", mid_id: m.id })} />)}
        </div>
      )}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Switch log</CardTitle><CardDescription>Every change, and every time traffic moved on its own, newest first.</CardDescription></CardHeader>
        <CardContent>
          {d.events.filter((e) => !e.kind || e.kind === kind).length === 0 ? (
            <p className="text-sm text-[color:var(--color-text-muted)]">Nothing yet.</p>
          ) : (
            <ul className="text-sm">
              {d.events.filter((e) => !e.kind || e.kind === kind).slice(0, 30).map((e, i) => (
                <li key={i} className="flex flex-wrap justify-between gap-2 border-b border-[color:var(--color-border)] py-1.5 last:border-0">
                  <span>{e.action === "AUTO_SWITCH" && <Zap className="mr-1 inline h-3.5 w-3.5 text-[color:var(--color-warning)]" />}{e.text}</span>
                  <span className="text-xs text-[color:var(--color-text-muted)]">{e.who} · {formatDateTime(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {edit && <MidDialog kind={kind} detail={d} mid={edit === "new" ? null : edit} onClose={() => setEdit(null)}
        busy={act.isPending} onSave={(body) => act.mutateAsync(body).then(() => setEdit(null))} />}
      {pinFor && <PinDialog m={pinFor} busy={act.isPending} onClose={() => setPinFor(null)}
        onSave={(minutes, reason) => act.mutateAsync({ action: "pin", kind, mid_id: pinFor.id, minutes, reason }).then(() => setPinFor(null))} />}
    </div>
  );
}

function Bar({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  return (
    <div className="mt-1 h-1.5 w-full rounded bg-[color:var(--color-surface-muted)]">
      <div className={cn("h-1.5 rounded", pct >= 100 ? "bg-[color:var(--color-danger)]" : pct >= 80 ? "bg-[color:var(--color-warning)]" : "bg-[color:var(--color-success)]")}
        style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

function MidCard({ m, mode, staff, busy, onEdit, onPin, onPause, onResume }: {
  m: MidViewRow; mode: MidMode; staff: boolean; busy: boolean;
  onEdit: () => void; onPin: () => void; onPause: () => void; onResume: () => void;
}) {
  const l = m.limits;
  const health = m.health.state === "UNHEALTHY" ? "danger" : m.health.state === "HEALTHY" ? "success" : "default";
  return (
    <Card className={cn(m.last_used && "border-[color:var(--color-brand)]")}>
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
        <div className="min-w-0">
          <CardTitle className="truncate text-base">{m.name}</CardTitle>
          <CardDescription className="truncate">
            {m.upi_id ?? (staff && m.gateway ? `${m.gateway} · ${m.env}` : "Processor account")}
            {" · "}{mode === "PRIORITY" ? `priority ${m.priority}` : `weight ${m.weight}`}
          </CardDescription>
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {m.last_used && <Badge variant="brand">taking traffic</Badge>}
          {m.pinned && <Badge variant="warning">switched by hand</Badge>}
          <Badge variant={m.status === "ACTIVE" ? "success" : m.status === "PAUSED" ? "warning" : "danger"}>{m.status.toLowerCase()}</Badge>
          <Badge variant={health} title={m.health.why ?? undefined}>
            {m.health.state === "UNKNOWN" ? "health: few orders" : `${m.health.state.toLowerCase()}${m.health.success_pct != null ? ` ${m.health.success_pct}%` : ""}`}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-xs text-[color:var(--color-text-muted)]">Today</div>
            <div className="tabular-nums">{formatAmount(m.usage.day_amount)}{l.daily_amount ? <span className="text-xs text-[color:var(--color-text-muted)]"> / {formatAmount(l.daily_amount)}</span> : null}</div>
            <Bar pct={m.usage.day_pct} />
          </div>
          <div>
            <div className="text-xs text-[color:var(--color-text-muted)]">Orders today</div>
            <div className="tabular-nums">{m.usage.day_count}{l.daily_count ? <span className="text-xs text-[color:var(--color-text-muted)]"> / {l.daily_count}</span> : null}</div>
            <Bar pct={m.usage.count_pct} />
          </div>
          <div>
            <div className="text-xs text-[color:var(--color-text-muted)]">This month</div>
            <div className="tabular-nums">{formatAmount(m.usage.month_amount)}{l.monthly_amount ? <span className="text-xs text-[color:var(--color-text-muted)]"> / {formatAmount(l.monthly_amount)}</span> : null}</div>
            <Bar pct={m.usage.month_pct} />
          </div>
        </div>
        <div className="text-xs text-[color:var(--color-text-muted)]">
          Per order {l.min_amount ? formatAmount(l.min_amount) : "any"} – {l.max_amount ? formatAmount(l.max_amount) : "any"}
          {" · "}{m.window.from && m.window.to ? `${m.window.from}–${m.window.to} IST` : "all day"}
          {m.window.days?.length ? ` · ${m.window.days.map((x) => DAYS[x - 1]).join(" ")}` : ""}
          {!m.window.open_now && " · closed now"}
        </div>
        {m.takes_traffic_now
          ? <div className="text-xs text-[color:var(--color-success)]">Can take payments now.</div>
          : <div className="text-xs text-[color:var(--color-danger)]">Not taking payments: {m.why_not_now.join("; ")}.</div>}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="secondary" disabled={busy || m.status !== "ACTIVE" || m.pinned} onClick={onPin}><ArrowRightLeft className="h-4 w-4" /> Send all traffic here</Button>
          {m.status === "ACTIVE"
            ? <Button size="sm" variant="ghost" disabled={busy} onClick={onPause}><Pause className="h-4 w-4" /> Pause</Button>
            : m.status === "PAUSED" || staff ? <Button size="sm" variant="ghost" disabled={busy} onClick={onResume}><Play className="h-4 w-4" /> Resume</Button> : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}><Pencil className="h-4 w-4" /> Limits</Button>
        </div>
      </CardContent>
    </Card>
  );
}

const numOrBlank = (v: number | null | undefined) => (v == null ? "" : String(v));

function MidDialog({ kind, detail, mid, busy, onClose, onSave }: {
  kind: MidKind; detail: SwitchDetail; mid: MidViewRow | null; busy: boolean;
  onClose: () => void; onSave: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [f, setF] = useState({
    pick: kind === "UPI" ? detail.can_add.UPI[0] ?? "" : detail.can_add.GATEWAY[0]?.vault_label ?? "",
    name: mid?.name ?? "", payee_name: mid?.payee_name ?? "",
    priority: numOrBlank(mid?.priority ?? detail.mids.filter((m) => m.kind === kind).length + 1), weight: numOrBlank(mid?.weight ?? 1),
    min_amount: numOrBlank(mid?.limits.min_amount), max_amount: numOrBlank(mid?.limits.max_amount),
    daily_amount: numOrBlank(mid?.limits.daily_amount), daily_count: numOrBlank(mid?.limits.daily_count), monthly_amount: numOrBlank(mid?.limits.monthly_amount),
    active_from: mid?.window.from ?? "", active_to: mid?.window.to ?? "", days: mid?.window.days ?? [] as number[],
    skip_unhealthy: mid?.health.skip_unhealthy ?? true, health_min_success: numOrBlank(mid?.health.min_success),
  });
  const set = (k: keyof typeof f, v: unknown) => setF({ ...f, [k]: v });
  const field = (k: keyof typeof f, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div><Label className="text-xs">{label}</Label><Input value={String(f[k])} onChange={(e) => set(k, e.target.value)} {...props} /></div>
  );
  const save = () => onSave({
    ...(mid ? { action: "update", mid_id: mid.id } : { action: "add", kind, ...(kind === "UPI" ? { upi_id: f.pick } : { vault_label: f.pick }) }),
    ...(f.name.trim() ? { name: f.name.trim() } : {}),
    ...(kind === "UPI" ? { payee_name: f.payee_name } : {}),
    priority: f.priority, weight: f.weight,
    min_amount: f.min_amount, max_amount: f.max_amount, daily_amount: f.daily_amount, daily_count: f.daily_count, monthly_amount: f.monthly_amount,
    active_from: f.active_from, active_to: f.active_to, active_days: f.days.length ? f.days : null,
    skip_unhealthy: f.skip_unhealthy, health_min_success: f.health_min_success,
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mid ? `Limits for ${mid.name}` : kind === "UPI" ? "Add a UPI ID to the switch" : "Add a processor account to the switch"}</DialogTitle>
          <DialogDescription>Leave a limit blank for none. Days and months are India time; failed and expired orders give their amount back.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {!mid && (
            <div className="sm:col-span-2"><Label className="text-xs">{kind === "UPI" ? "UPI ID" : "Account"}</Label>
              <select value={f.pick} onChange={(e) => set("pick", e.target.value)} className={sel}>
                {kind === "UPI"
                  ? detail.can_add.UPI.map((u) => <option key={u} value={u}>{u}</option>)
                  : detail.can_add.GATEWAY.map((a) => <option key={a.vault_label} value={a.vault_label}>{a.gateway} {a.mid_code} ({a.env})</option>)}
              </select></div>
          )}
          {field("name", "Name (shown on the dashboard)", { placeholder: kind === "UPI" ? f.pick : "Processor account 2" })}
          {kind === "UPI" && field("payee_name", "Name registered on the UPI ID (optional)")}
          {field("priority", "Priority (1 is tried first)", { type: "number", min: 1, max: 99 })}
          {field("weight", "Weight (share in a weighted split)", { type: "number", min: 0, max: 100 })}
          {field("min_amount", "Smallest order (₹)", { type: "number" })}
          {field("max_amount", "Largest order (₹)", { type: "number" })}
          {field("daily_amount", "Per day (₹)", { type: "number" })}
          {field("daily_count", "Orders per day", { type: "number" })}
          {field("monthly_amount", "Per month (₹)", { type: "number" })}
          <div />
          {field("active_from", "Takes traffic from (IST)", { type: "time" })}
          {field("active_to", "until (IST)", { type: "time" })}
          <div className="sm:col-span-2"><Label className="text-xs">On these days (none ticked = every day)</Label>
            <div className="flex flex-wrap gap-3 pt-1 text-sm">
              {DAYS.map((name, i) => (
                <label key={name} className="flex items-center gap-1">
                  <input type="checkbox" checked={f.days.includes(i + 1)}
                    onChange={(e) => set("days", e.target.checked ? [...f.days, i + 1].sort() : f.days.filter((x) => x !== i + 1))} /> {name}
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={f.skip_unhealthy} onChange={(e) => set("skip_unhealthy", e.target.checked)} />
            Skip it while unhealthy (too few recent orders paid, or orders failing to be created)
          </label>
          {f.skip_unhealthy && field("health_min_success", "Unhealthy below this % paid (blank = platform default)", { type: "number", min: 1, max: 100 })}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || (!mid && !f.pick)} onClick={save}>{mid ? "Save" : "Add"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PinDialog({ m, busy, onClose, onSave }: { m: MidViewRow; busy: boolean; onClose: () => void; onSave: (minutes: number | null, reason: string) => Promise<unknown> }) {
  const [minutes, setMinutes] = useState<string>("60");
  const [reason, setReason] = useState("");
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send all traffic to {m.name}</DialogTitle>
          <DialogDescription>Every new order goes to it while it can take the order. When it cannot (a limit, its hours, paused), the automatic rule takes over for that order.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div><Label className="text-xs">For how long</Label>
            <select value={minutes} onChange={(e) => setMinutes(e.target.value)} className={sel}>
              <option value="30">30 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option>
              <option value="1440">24 hours</option><option value="">Until I switch back</option>
            </select></div>
          <div><Label className="text-xs">Why (optional)</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => onSave(minutes ? Number(minutes) : null, reason)}>Switch now</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
