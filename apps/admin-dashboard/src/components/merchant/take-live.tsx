"use client";

// "Take live" (staff, Super Admin): everything between a banker and live money in one place —
// onboarding approval, live mode, each payment account's go-live, and a real ₹1 payment
// (lib/take-live). Each button calls the existing route with its checks; a refused step shows why
// and, where a Super Admin may, takes a note to go ahead anyway — the same overrides as the
// individual pages, recorded the same way. Renders nothing once everything is live.
// Onboarding and live mode are the banker's own. Then how customers pay — P2P, Intent or Both —
// saved as the banker's pay-in flow (PUT …/payin-flow, after the same "Before you save" check as
// the flow card), with a P2P ⇄ Intent switch while one flow is chosen (off with Both). Below, one
// tab per flow in use, each with only that flow's setup, accounts, real payment and live test.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Check, Circle, Loader2, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { IntentLiveTestCard } from "@/components/merchant/intent-live-test";
import { useImpactConfirm } from "@/components/merchant/confirm-impact";
import { cn } from "@/lib/utils";
import {
  accountFlow, commonLiveItems, flowLiveItems, flowsInUse, gateWords, nextOnboardingStep,
  type GoLiveAccount, type LiveFlow, type LiveItem,
} from "@/lib/take-live";

interface Merchant { id: string; merchant_code: string; stage: string; step_config?: boolean }
interface Gate { gate: string; result: string; summary?: string }
type Ask = null | { kind: "GATE"; step: string; label: string; gates: Gate[] } | { kind: "SETUP"; missing: string[] };

const post = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
};

export function TakeLivePanel({ merchantId, merchantCode, flow, alwaysShow = false }: {
  merchantId: string; merchantCode: string; flow?: "P2P" | "INTENT"; alwaysShow?: boolean;
}) {
  const qc = useQueryClient();
  const key = ["take-live", merchantId];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const [list, act, gl, tests, fl] = await Promise.all([
        fetch("/api/merchants").then((r) => r.json()).catch(() => ({ merchants: [] })),
        fetch(`/api/merchants/${merchantId}/live-activation`).then((r) => r.json()).catch(() => ({})),
        fetch(`/api/ops/gateway-golive?merchant=${encodeURIComponent(merchantCode)}`).then((r) => r.json()).catch(() => ({ accounts: [] })),
        fetch(`/api/merchants/${merchantId}/intent-test`).then((r) => r.json()).catch(() => ({ tests: [] })),
        fetch(`/api/merchants/${merchantId}/payin-flow`).then((r) => r.json()).catch(() => null),
      ]);
      const m = ((list.merchants ?? []) as Merchant[]).find((x) => x.id === merchantId || x.merchant_code === merchantCode) ?? null;
      return {
        m, live: String(act.status ?? "NOT_REQUESTED"), setupMissing: (act.setup_missing ?? []) as string[],
        accounts: (gl.accounts ?? []) as (GoLiveAccount & { checklist?: { key: string; label: string; done: boolean }[] })[],
        paid: ((tests.tests ?? []) as { status: string; channel_type: string | null }[])
          .filter((t) => t.status === "SUCCESS").map((t) => (t.channel_type === "P2P" ? "P2P" : "INTENT") as LiveFlow),
        // The banker's flow in force (its own, or its merchant's). The wizard's flow is the fallback.
        setting: (fl?.flow ?? flow ?? "UNSET") as "P2P" | "INTENT" | "BOTH" | "UNSET",
        inherited: fl?.source === "MERCHANT",
        inUse: fl ? flowsInUse(fl.flow) : flow ? [flow] : flowsInUse(null),
        active: (flow ?? (fl?.active === "INTENT" || fl?.flow === "INTENT" ? "INTENT" : "P2P")) as LiveFlow,
        ready: { P2P: !!fl?.readiness?.p2p, INTENT: !!fl?.readiness?.intent } as Record<LiveFlow, boolean>,
        p2pMethod: (fl?.readiness?.p2pMethod ?? null) as string | null,
      };
    },
    refetchInterval: 15_000,
  });
  const [busy, setBusy] = useState<string | null>(null);
  // Where a message belongs: the common steps or one flow's tab.
  const [msg, setMsgAt] = useState<{ tone: "ok" | "bad"; text: string; at: "COMMON" | LiveFlow } | null>(null);
  const setMsg = (m: { tone: "ok" | "bad"; text: string } | null, at: "COMMON" | LiveFlow = "COMMON") => setMsgAt(m && { ...m, at });
  const [tab, setTab] = useState<LiveFlow | null>(null);
  const impact = useImpactConfirm();
  const [ask, setAsk] = useState<Ask>(null);
  const [note, setNote] = useState("");
  const [risk, setRisk] = useState<"LOW" | "MEDIUM" | "HIGH">("LOW");
  const refresh = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ["merchant", merchantId] }); qc.invalidateQueries({ queryKey: ["merchants"] }); };

  const d = q.data;
  if (!d?.m) return q.isLoading ? null : null;
  const common = commonLiveItems(d.m, d.live);
  const perFlow = Object.fromEntries((["P2P", "INTENT"] as const).map((f) => [f, flowLiveItems(f, {
    ready: d.ready[f], p2pMethod: d.p2pMethod, accounts: d.accounts, paidLive: d.paid.includes(f),
  })])) as Record<LiveFlow, LiveItem[]>;
  if (!alwaysShow && common.every((i) => i.done) && d.inUse.every((f) => perFlow[f].every((i) => i.done))) return null;
  const liveOn = common[1].done;

  /** Approve onboarding step after step; stops at a refusal and asks for an override note. */
  async function approveSteps(override = false) {
    setBusy("ONBOARDING"); setMsg(null);
    let m = d!.m!;
    for (let guard = 0; guard < 8; guard++) {
      const s = nextOnboardingStep(m);
      if (!s) break;
      const useOverride = override && ask?.kind === "GATE" && ask.step === s.key;
      const r = await post(`/api/merchants/${merchantId}/advance`, {
        step: s.key, notes: useOverride ? note.trim() : "approved from Take live",
        ...(s.key === "step_screening" ? { risk_tier: risk } : {}), ...(useOverride ? { override: true } : {}),
      });
      if (!r.ok) {
        if (r.d.code === "GATE_FAILED") {
          const gates = ((r.d.gates ?? []) as Gate[]).filter((g) => g.result !== "PASS");
          setAsk(r.d.can_override ? { kind: "GATE", step: s.key, label: s.label, gates } : null);
          setMsg({ tone: "bad", text: `${s.label} was refused: ${gates.map(gateWords).join("; ")}` });
        } else setMsg({ tone: "bad", text: `${s.label}: ${r.d.error ?? `HTTP ${r.status}`}` });
        setBusy(null); refresh(); return;
      }
      setAsk(null); setNote(""); override = false;
      m = { ...m, stage: r.d.stage ?? m.stage, step_config: s.key === "step_config" ? true : m.step_config };
    }
    setMsg({ tone: "ok", text: "Onboarding approved." }); setBusy(null); refresh();
  }

  async function switchOnLive(override = false) {
    setBusy("LIVE_MODE"); setMsg(null);
    const r = await post(`/api/merchants/${merchantId}/live-activation`, {
      decision: "APPROVE", reason: override ? note.trim() : "approved from Take live", ...(override ? { override_setup: true } : {}),
    });
    if (!r.ok) {
      if (r.d.code === "SETUP_INCOMPLETE") { setAsk({ kind: "SETUP", missing: d!.setupMissing }); setMsg({ tone: "bad", text: r.d.error }); }
      else setMsg({ tone: "bad", text: r.d.error ?? `HTTP ${r.status}` });
    } else { setAsk(null); setNote(""); setMsg({ tone: "ok", text: "Live mode is on." }); }
    setBusy(null); refresh();
  }

  /** Save how customers pay (the banker's own flow). With Both, the flow in use stays the one it was on. */
  async function changeFlow(to: "P2P" | "INTENT" | "BOTH") {
    if (!d || to === d.setting || busy) return;
    if (!(await impact.ask(`/api/merchants/${merchantId}/impact?change=FLOW&to=${to}`))) return;
    setBusy("FLOW"); setMsg(null);
    const r = await fetch(`/api/merchants/${merchantId}/payin-flow`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flow: to, active: to === "BOTH" ? d.active : null, note: "changed from Take live" }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) setMsg({ tone: "bad", text: body.error ?? `HTTP ${r.status}` });
    else {
      setMsg({ tone: "ok", text: to === "BOTH" ? "This banker now takes P2P and Intent." : `This banker now takes ${to === "P2P" ? "P2P" : "Intent"} only.` });
      setTab(to === "BOTH" ? null : to);
    }
    setBusy(null); refresh(); qc.invalidateQueries({ queryKey: ["payin-flow"] }); qc.invalidateQueries({ queryKey: ["payin-flows"] });
  }

  async function setAccountLive(a: GoLiveAccount) {
    setBusy(`ACCOUNT:${a.account}`); setMsg(null);
    const at = accountFlow(a);
    for (const action of ["ping", "webhook", "status", "live"] as const) {
      const r = await post("/api/ops/gateway-golive", { merchant_id: merchantCode, gateway: a.gateway, account: a.account, action });
      if (!r.ok) {
        setMsg({ tone: "bad", text: action === "webhook" || action === "status"
          ? `${a.gateway}: ${r.d.error ?? "no confirmed real payment yet"}. Make the live test payment below, then try again.`
          : `${a.gateway} (${action}): ${r.d.error ?? `HTTP ${r.status}`}` }, at);
        setBusy(null); refresh(); return;
      }
    }
    setMsg({ tone: "ok", text: `${a.gateway} is live.` }, at); setBusy(null); refresh();
  }

  const mark = (it: LiveItem) => it.done
    ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-success)]" />
    : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-warning)]" />;
  const message = (at: "COMMON" | LiveFlow) => msg?.at === at && (
    <div role="status" className={cn("rounded-xl border px-3 py-2", msg.tone === "ok"
      ? "border-[color:var(--color-success)] bg-[color:var(--color-success-muted)]" : "border-[color:var(--color-danger)] bg-[color:var(--color-danger-muted)]")}>{msg.text}</div>
  );
  const shownTab = tab && d.inUse.includes(tab) ? tab : d.inUse.includes(d.active) ? d.active : d.inUse[0];

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Rocket className="h-4 w-4" /> Take {merchantCode} live</CardTitle>
        <CardDescription>Everything between this banker and live money, in order. Each step runs the usual checks.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <ol className="space-y-3">
          {common.map((it) => (
            <li key={it.key} className="flex gap-3">
              {mark(it)}
              <div className="min-w-0 flex-1 space-y-2">
                <div><span className="font-medium">{it.label}</span><span className="text-[color:var(--color-text-muted)]"> — {it.detail}</span></div>

                {it.key === "ONBOARDING" && !it.done && (
                  <div className="flex flex-wrap items-center gap-2">
                    {nextOnboardingStep(d.m!)?.from === "SCREENING" || ["APPLICATION", "DOCS_PENDING", "SCREENING"].includes(d.m!.stage) ? (
                      <label className="flex items-center gap-1.5 text-xs">Risk level
                        <select value={risk} onChange={(e) => setRisk(e.target.value as typeof risk)} className="h-8 rounded-md border bg-[color:var(--color-surface)] px-2">
                          <option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option>
                        </select>
                      </label>
                    ) : null}
                    <Button size="sm" onClick={() => approveSteps()} disabled={!!busy}>
                      {busy === "ONBOARDING" ? <><Loader2 className="h-4 w-4 animate-spin" /> Approving…</> : "Approve the remaining steps"}
                    </Button>
                  </div>
                )}

                {it.key === "LIVE_MODE" && !it.done && (
                  <Button size="sm" onClick={() => switchOnLive()} disabled={!!busy || !common[0].done}>
                    {busy === "LIVE_MODE" ? <><Loader2 className="h-4 w-4 animate-spin" /> Switching on…</> : "Switch on live mode"}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>

        {message("COMMON")}

        <div className="space-y-3 border-t border-[color:var(--color-border)] pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">How customers pay</span>
            {d.setting === "UNSET" && <span className="text-xs text-[color:var(--color-warning)]">not chosen yet</span>}
            {d.inherited && <span className="text-xs text-[color:var(--color-text-muted)]">(from its merchant; a change here is this banker&apos;s own)</span>}
          </div>
          <div role="radiogroup" aria-label="How customers pay" className="inline-flex rounded-lg border border-[color:var(--color-border)] p-0.5">
            {([["P2P", "P2P"], ["INTENT", "Intent"], ["BOTH", "Both"]] as const).map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={d.setting === v} disabled={!!busy}
                onClick={() => changeFlow(v)}
                className={cn("rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60",
                  d.setting === v ? "bg-[color:var(--color-brand)] text-white" : "text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]")}>
                {label}
              </button>
            ))}
          </div>
          {(() => {
            const single = d.setting === "P2P" || d.setting === "INTENT";
            const other = d.setting === "P2P" ? "INTENT" : "P2P";
            return (
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" role="switch" aria-checked={d.setting === "INTENT"} aria-label="Switch between P2P and Intent"
                  disabled={!single || !!busy} onClick={() => changeFlow(other)}
                  className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                    d.setting === "INTENT" ? "bg-[color:var(--color-brand)]" : "bg-[color:var(--color-border)]")}>
                  <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", d.setting === "INTENT" ? "left-[22px]" : "left-0.5")} />
                </button>
                <span className="flex items-center gap-1.5 text-sm">
                  <span className={d.setting === "P2P" ? "font-medium" : "text-[color:var(--color-text-muted)]"}>P2P</span>
                  <ArrowLeftRight className="h-3.5 w-3.5 text-[color:var(--color-text-muted)]" />
                  <span className={d.setting === "INTENT" ? "font-medium" : "text-[color:var(--color-text-muted)]"}>Intent</span>
                </span>
                <span className="text-xs text-[color:var(--color-text-muted)]">
                  {busy === "FLOW" ? "Saving…"
                    : d.setting === "BOTH" ? `Switch off: both flows are on. Orders that don't name a flow use ${d.active === "P2P" ? "P2P" : "Intent"}.`
                    : single ? `Switch to take ${other === "P2P" ? "P2P" : "Intent"} instead.`
                    : "Choose P2P or Intent first."}
                </span>
              </div>
            );
          })()}
        </div>

        {ask && (
          <div className="space-y-2 rounded-xl border border-[color:var(--color-warning)] bg-[color:var(--color-warning-muted)] px-3 py-3">
            <div className="font-medium">{ask.kind === "GATE" ? `Mark “${ask.label}” done anyway?` : "Switch on live mode anyway?"}</div>
            {ask.kind === "SETUP" && ask.missing.length > 0 && <div className="text-xs">Missing: {ask.missing.join("; ")}</div>}
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why (at least 5 characters) — kept in the audit log" maxLength={300} />
            <div className="flex gap-2">
              <Button size="sm" disabled={note.trim().length < 5 || !!busy} onClick={() => (ask.kind === "GATE" ? approveSteps(true) : switchOnLive(true))}>Go ahead with this note</Button>
              <Button size="sm" variant="ghost" onClick={() => { setAsk(null); setNote(""); }}>Not now</Button>
            </div>
          </div>
        )}

        <Tabs value={shownTab} onValueChange={(v) => { setTab(v as LiveFlow); setMsg(null); }} className="border-t border-[color:var(--color-border)] pt-4">
          <TabsList>
            {d.inUse.map((f) => {
              const left = perFlow[f].filter((i) => !i.done).length;
              return (
                <TabsTrigger key={f} value={f}>
                  {f === "P2P" ? "P2P · pays UPI ID" : "Intent · pays via gateway"}
                  {left ? <span className="text-xs font-normal text-[color:var(--color-warning)]">{left} left</span>
                    : <Check className="h-3.5 w-3.5 text-[color:var(--color-success)]" />}
                </TabsTrigger>
              );
            })}
          </TabsList>

          {d.inUse.map((f) => (
            <TabsContent key={f} value={f} className="space-y-4 pt-4">
              <ol className="space-y-3">
                {perFlow[f].map((it) => (
                  <li key={it.key} className="flex gap-3">
                    {mark(it)}
                    <div className="min-w-0 flex-1 space-y-2">
                      <div><span className="font-medium">{it.label}</span><span className="text-[color:var(--color-text-muted)]"> — {it.detail}</span></div>
                      {it.key === "ACCOUNT" && d.accounts.filter((a) => a.status === "VERIFYING" && accountFlow(a) === f).map((a) => (
                        <div key={a.account} className="rounded-xl border border-[color:var(--color-border)] px-3 py-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium">{a.gateway}{a.account !== "gateway_mid" && a.account_label ? ` · ${a.account_label}` : ""}</span>
                            <Button size="sm" variant="secondary" onClick={() => setAccountLive(a)} disabled={!!busy || !liveOn}>
                              {busy === `ACCOUNT:${a.account}` ? <><Loader2 className="h-4 w-4 animate-spin" /> Checking…</> : "Check and set live"}
                            </Button>
                          </div>
                          <ul className="mt-1 space-y-0.5 text-xs text-[color:var(--color-text-muted)]">
                            {(a.checklist ?? []).filter((c) => c.key !== "RECORD").map((c) => <li key={c.key}>{c.done ? "✓" : "○"} {c.label}</li>)}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>

              {message(f)}

              {liveOn ? (
                <div className="border-t border-[color:var(--color-border)] pt-4">
                  <IntentLiveTestCard merchantId={merchantId} merchantCode={merchantCode} flow={f} />
                </div>
              ) : (
                <p className="text-xs text-[color:var(--color-text-muted)]">The live test payment appears here once live mode is on.</p>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
      {impact.dialog}
    </Card>
  );
}
