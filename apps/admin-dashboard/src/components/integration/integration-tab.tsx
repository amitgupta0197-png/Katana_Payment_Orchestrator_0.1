"use client";

// A banker's integration, for staff (lib/integration-store): health score per flow, Key + Salt,
// webhook, the callback URL of each flow with its checks, and the integration log. Rendered only
// on the staff banker page's Integration tab. Changing a callback URL goes to Maker-Checker.

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { History, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/utils";
import { FLOW_LABEL, type Band, type CallbackFlow } from "@/lib/integration";
import type { CallbackView, FlowScore, Integration, IntegrationEvent, PingRow } from "@/lib/integration-store";

const muted = "text-[color:var(--color-text-muted)]";
const BAND_COLOR: Record<Band, string> = {
  GREEN: "var(--color-success)", AMBER: "var(--color-warning)", RED: "var(--color-danger)", GREY: "var(--color-text-subtle)",
};
const STATUS_VARIANT = { VERIFIED: "success", PENDING: "warning", FAILED: "danger" } as const;
const STATUS_LABEL = { VERIFIED: "Verified", PENDING: "Not checked yet", FAILED: "Failing" } as const;

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init ? { ...init, headers: { "Content-Type": "application/json" } } : undefined);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
  return d as T;
}

const when = (v: string | null | undefined) => (v ? formatDateTime(v) : "never");

export function ScoreRing({ score, band, label, size = 72 }: { score: number | null; band: Band; label: string; size?: number }) {
  const r = (size - 8) / 2, c = 2 * Math.PI * r, pct = score ?? 0;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}: ${score ?? "no"} score`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-border)" strokeWidth={6} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={BAND_COLOR[band]} strokeWidth={6} strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fontSize={size / 4} fontWeight={600} fill="currentColor">
          {score ?? "–"}
        </text>
      </svg>
      <span className={`text-xs ${muted}`}>{label}</span>
    </div>
  );
}

export function IntegrationTab({ merchantId, canEdit, onOpenTab }: { merchantId: string; canEdit: boolean; onOpenTab?: (t: string) => void }) {
  const key = ["merchant", merchantId, "integration"];
  const q = useQuery({ queryKey: key, queryFn: () => call<Integration>(`/api/merchants/${merchantId}/integration`) });
  if (q.isLoading) return <Card><CardContent className={`py-8 text-center text-sm ${muted}`}>Loading…</CardContent></Card>;
  if (q.error || !q.data) return <Card><CardContent className="py-8 text-center text-sm text-[color:var(--color-danger)]">Could not load: {(q.error as Error)?.message ?? "no data"}</CardContent></Card>;
  const d = q.data;
  return (
    <div className="space-y-4">
      <ScoresCard d={d} onOpenTab={onOpenTab} />
      <div className="grid gap-4 lg:grid-cols-2 [&>*]:mb-0">
        <KeysCard d={d} onOpenTab={onOpenTab} />
        <WebhookCard d={d} merchantId={merchantId} canEdit={canEdit} />
      </div>
      <div className="grid gap-4 xl:grid-cols-3 [&>*]:mb-0">
        {d.callbacks.map((c) => (
          <CallbackCard key={c.flow} merchantId={merchantId} cb={c} score={d.scores.find((s) => s.flow === c.flow)!} canEdit={canEdit} />
        ))}
      </div>
      <LogCard events={d.events} />
    </div>
  );
}

function ScoresCard({ d, onOpenTab }: { d: Integration; onOpenTab?: (t: string) => void }) {
  const shown = d.scores.filter((s) => s.active);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Integration health</CardTitle>
        <CardDescription>
          One score per flow this banker is on. Overall is the weakest flow.
          {" "}Services: {d.services.toLowerCase()} · pay-in flow: {d.payin_flow.toLowerCase()}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-start gap-6">
          <ScoreRing score={d.overall.score} band={d.overall.band} label="Overall" size={88} />
          {shown.length === 0 && <p className={`self-center text-sm ${muted}`}>No flow chosen and nothing used in 30 days.</p>}
          {shown.map((s) => <ScoreRing key={s.flow} score={s.score} band={s.band} label={FLOW_LABEL[s.flow]} />)}
        </div>
        {shown.length > 0 && (
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {shown.map((s) => <ScoreItems key={s.flow} s={s} onOpenTab={onOpenTab} />)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Where a failing health item is fixed: a tab of the banker page, or a card further down this one. */
function fixFor(key: string, flow: CallbackFlow): { how: string; label: string; tab?: string; anchor?: string } | null {
  switch (key) {
    case "key": return { how: "Make the banker's Key + Salt (live once live mode is on).", label: "Open API login", tab: "developer" };
    case "callback_url": return { how: "Set the URL Katana sends payment messages to: this flow's own, or the default one.", label: "Set the callback URL", anchor: "default-callback" };
    case "verified": return { how: "Press Verify now on the callback URL card. Katana sends a test message and the URL must answer 2xx.", label: "Go to Verify now", anchor: "default-callback" };
    case "payment": return flow === "PAYOUT"
      ? { how: "Make one successful payout (a test payout counts).", label: "Open Payouts", tab: "payouts" }
      : { how: "Make one successful payment on this flow (the live test on its tab counts).", label: flow === "P2P" ? "Open P2P live test" : "Open Intent live test", tab: flow === "P2P" ? "p2p" : "intent" };
    case "secret": return { how: "Make the webhook signing secret so v2 messages can be checked.", label: "Make the signing secret", anchor: "default-callback" };
    default: return null;
  }
}

function ScoreItems({ s, onOpenTab }: { s: FlowScore; onOpenTab?: (t: string) => void }) {
  const go = (f: NonNullable<ReturnType<typeof fixFor>>) => {
    if (f.tab && onOpenTab) return onOpenTab(f.tab);
    if (f.anchor) document.getElementById(f.anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="mb-1.5 font-medium">{FLOW_LABEL[s.flow]}</div>
      <ul className="space-y-1.5">
        {s.items.map((i) => {
          const fix = i.ok ? null : fixFor(i.key, s.flow as CallbackFlow);
          return (
            <li key={i.key} className="flex gap-2">
              <span aria-hidden style={{ color: i.ok ? BAND_COLOR.GREEN : BAND_COLOR.RED }}>{i.ok ? "✓" : "✗"}</span>
              <span className="min-w-0">
                <span className={i.ok ? "" : muted}>{i.label}</span>
                {fix && (
                  <span className={`block text-xs ${muted}`}>
                    {fix.how}{" "}
                    {(fix.anchor || onOpenTab) && (
                      <button type="button" className="text-[color:var(--color-brand)] hover:underline" onClick={() => go(fix)}>{fix.label} →</button>
                    )}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div className={`mt-1.5 text-xs ${muted}`}>{s.successes_30d} paid of {s.payments_30d} in 30 days</div>
    </div>
  );
}

function KeysCard({ d, onOpenTab }: { d: Integration; onOpenTab?: (t: string) => void }) {
  const row = (label: string, k: Integration["keys"]["live"]) => (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {k.exists
          ? <div className={`text-xs ${muted}`}><span className="font-mono">{k.key}</span><br />Made {when(k.created_at)} · last used {when(k.last_used_at)}</div>
          : <div className={`text-xs ${muted}`}>Not made yet</div>}
      </div>
      <Badge variant={k.exists ? "success" : "default"}>{k.exists ? "Active" : "None"}</Badge>
    </div>
  );
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Key + Salt</CardTitle>
        <CardDescription>The Salt is never shown here.</CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        {row("Live", d.keys.live)}
        {row("Test", d.keys.test)}
        <div className={`pt-2 text-xs ${muted}`}>
          v2 API keys: {d.v2_keys.live_active} live, {d.v2_keys.test_active} test · last used {when(d.v2_keys.last_used_at)}
          {onOpenTab && <> · <button type="button" className="text-[color:var(--color-brand)] hover:underline" onClick={() => onOpenTab("developer")}>Manage on the Developer tab</button></>}
        </div>
      </CardContent>
    </Card>
  );
}

function WebhookCard({ d, merchantId, canEdit }: { d: Integration; merchantId: string; canEdit: boolean }) {
  const cb = d.default_callback;
  return (
    <Card id="default-callback" className="scroll-mt-20">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Default callback URL</CardTitle>
        <CardDescription>Used for every flow that has no URL of its own.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="break-all font-mono text-xs">{cb.url ?? "Not set"}</div>
        <div className="flex flex-wrap gap-2">
          {cb.status && <Badge variant={STATUS_VARIANT[cb.status]}>{STATUS_LABEL[cb.status]}</Badge>}
          <Badge variant="default">Webhook {d.webhook.effective_version}{d.webhook.version !== d.webhook.effective_version ? ` (v2 waits for a secret)` : ""}</Badge>
          <Badge variant="default">{d.webhook.events === "PAID_ONLY" ? "Paid only" : "All outcomes"}</Badge>
          {d.webhook.version === "v2" && <Badge variant={d.webhook.has_secret ? "success" : "warning"}>{d.webhook.has_secret ? "Signing secret made" : "No signing secret"}</Badge>}
        </div>
        <CheckLine cb={cb} />
        {cb.url && <CheckActions merchantId={merchantId} cb={cb} canEdit={canEdit} />}
      </CardContent>
    </Card>
  );
}

function CheckLine({ cb }: { cb: CallbackView }) {
  if (!cb.last_checked_at) return <div className={`text-xs ${muted}`}>Not checked yet.</div>;
  return (
    <div className={`text-xs ${muted}`}>
      Last check {when(cb.last_checked_at)}{cb.last_http_status ? ` · HTTP ${cb.last_http_status}` : ""}
      {cb.last_error && <span className="text-[color:var(--color-danger)]"> · {cb.last_error}</span>}
      <br />Last passed {when(cb.verified_at)}
      {cb.consecutive_failures > 0 && <> · {cb.consecutive_failures} failed in a row</>}
    </div>
  );
}

function CheckActions({ merchantId, cb, canEdit }: { merchantId: string; cb: CallbackView; canEdit: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const verify = useMutation({
    mutationFn: () => call<{ ok: boolean; http_status: number | null; error: string | null; note?: string }>(`/api/merchants/${merchantId}/integration/verify`,
      { method: "POST", body: JSON.stringify({ flow: cb.flow }) }),
    onSuccess: (r) => {
      if (r.ok && r.note) toast.warning("The URL is reachable", { description: r.note });
      else if (r.ok) toast.success(`The URL answered${r.http_status ? ` (HTTP ${r.http_status})` : ""}`);
      else toast.error("The check failed", { description: r.error ?? undefined });
      qc.invalidateQueries({ queryKey: ["merchant", merchantId, "integration"] });
    },
    onError: (e: Error) => toast.error("Could not check", { description: e.message }),
  });
  return (
    <div className="flex flex-wrap gap-2">
      {canEdit && (
        <Button size="sm" variant="secondary" disabled={verify.isPending} onClick={() => verify.mutate()}>
          <RefreshCw className={`h-3.5 w-3.5 ${verify.isPending ? "animate-spin" : ""}`} /> {verify.isPending ? "Checking…" : "Verify now"}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><History className="h-3.5 w-3.5" /> Ping history</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Last checks{cb.flow ? `: ${FLOW_LABEL[cb.flow]}` : ""}</DialogTitle>
            <DialogDescription>A signed test event is sent; any 2xx answer passes.</DialogDescription>
          </DialogHeader>
          <PingTable pings={cb.pings} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PingTable({ pings }: { pings: PingRow[] }) {
  const cols: Column<PingRow>[] = [
    { key: "at", header: "When", render: (r) => formatDateTime(r.at) },
    { key: "ok", header: "Result", render: (r) => <Badge variant={r.ok ? "success" : "danger"}>{r.ok ? "Passed" : "Failed"}</Badge> },
    { key: "http_status", header: "HTTP", render: (r) => r.http_status ?? "—" },
    { key: "response_ms", header: "Time", render: (r) => (r.response_ms != null ? `${r.response_ms} ms` : "—") },
    { key: "triggered_by", header: "By", render: (r) => (r.triggered_by === "SCHEDULED" ? "Schedule" : r.actor ?? "Staff") },
    { key: "error", header: "Note", render: (r) => <span className="break-all text-xs">{r.error ?? ""}</span> },
  ];
  return <DataTable columns={cols} rows={pings} rowKey={(r) => r.id} emptyState="No checks yet." />;
}

function CallbackCard({ merchantId, cb, score, canEdit }: { merchantId: string; cb: CallbackView; score: FlowScore; canEdit: boolean }) {
  const flow = cb.flow as CallbackFlow;
  return (
    <Card id={`callback-${flow}`} className={`scroll-mt-20 ${score.active ? "" : "opacity-80"}`}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          {FLOW_LABEL[flow]} callback
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: BAND_COLOR[cb.band] }} aria-hidden />
        </CardTitle>
        <CardDescription>{score.active ? "In use by this banker." : "Not a flow this banker is on."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {cb.url ? (
          <>
            <div className="break-all font-mono text-xs">{cb.url}</div>
            {cb.status && <Badge variant={STATUS_VARIANT[cb.status]}>{STATUS_LABEL[cb.status]}</Badge>}
            {cb.status === "FAILED" && <div className="text-xs text-[color:var(--color-danger)]">Failing: callbacks go to the default URL until it passes a check.</div>}
            <CheckLine cb={cb} />
            <CheckActions merchantId={merchantId} cb={cb} canEdit={canEdit} />
          </>
        ) : (
          <div className={`text-xs ${muted}`}>No URL of its own. Callbacks go to {cb.effective_url ? "the default URL" : "nowhere: no URL is set"}.</div>
        )}
        {cb.pending_request && (
          <div className="rounded-md border border-[color:var(--color-warning)]/40 px-2 py-1.5 text-xs">
            A change is waiting for a checker. <Link className="text-[color:var(--color-brand)] hover:underline" href="/admin/maker-checker">Open Maker-Checker</Link>
          </div>
        )}
        {canEdit && !cb.pending_request && <ChangeUrl merchantId={merchantId} flow={flow} current={cb.url} />}
      </CardContent>
    </Card>
  );
}

function ChangeUrl({ merchantId, flow, current }: { merchantId: string; flow: CallbackFlow; current: string | null }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(current ?? "");
  const [notes, setNotes] = useState("");
  const send = useMutation({
    mutationFn: (value: string | null) => call<{ request_id: string }>(`/api/merchants/${merchantId}/integration/callbacks`,
      { method: "PUT", body: JSON.stringify({ flow, url: value, notes: notes || undefined }) }),
    onSuccess: () => {
      toast.success("Sent for approval", {
        description: "A second person approves it on Maker-Checker; then it is checked.",
        action: { label: "Open", onClick: () => { window.location.href = "/admin/maker-checker"; } },
      });
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["merchant", merchantId, "integration"] });
    },
    onError: (e: Error) => toast.error("Not sent", { description: e.message }),
  });
  return (
    <>
      <div className="flex gap-2 pt-1">
        <Button size="sm" variant="secondary" onClick={() => { setUrl(current ?? ""); setOpen(true); }}>{current ? "Change URL" : "Set a URL"}</Button>
        {current && <Button size="sm" variant="ghost" disabled={send.isPending} onClick={() => send.mutate(null)}>Clear</Button>}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{FLOW_LABEL[flow]} callback URL</DialogTitle>
            <DialogDescription>Needs a second person's approval. Until then nothing changes.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={`cb-${flow}`}>URL</Label>
              <Input id={`cb-${flow}`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`cb-note-${flow}`}>Note for the checker (optional)</Label>
              <Input id={`cb-note-${flow}`} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!url.trim() || send.isPending} onClick={() => send.mutate(url.trim())}>{send.isPending ? "Sending…" : "Send for approval"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const EVENT_LABEL: Record<string, string> = {
  key_generated: "Key made", key_rotated: "Key made again", callback_url_set: "Callback URL set", callback_url_cleared: "Callback URL cleared",
  callback_verified: "Check passed", callback_reachable: "Reached (test order rejected)", callback_failed: "Check failed", test_txn_success: "Test payment paid",
};

function LogCard({ events }: { events: IntegrationEvent[] }) {
  const cols: Column<IntegrationEvent>[] = [
    { key: "at", header: "When", render: (r) => formatDateTime(r.at) },
    { key: "event", header: "What", render: (r) => EVENT_LABEL[r.event] ?? r.event },
    { key: "flow", header: "Flow", render: (r) => (r.flow ? FLOW_LABEL[r.flow as CallbackFlow] ?? r.flow : "Default") },
    { key: "detail", header: "Detail", render: (r) => {
      const d = r.detail as { url?: string; http_status?: number; error?: string; note?: string };
      return <span className="break-all text-xs">{[d.url, d.http_status ? `HTTP ${d.http_status}` : null, d.error, d.note].filter(Boolean).join(" · ")}</span>;
    } },
    { key: "actor", header: "By", render: (r) => r.actor ?? "—" },
  ];
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">Integration log</CardTitle><CardDescription>The last 50 entries.</CardDescription></CardHeader>
      <CardContent><DataTable columns={cols} rows={events} rowKey={(r) => r.id} emptyState="Nothing logged yet." /></CardContent>
    </Card>
  );
}
