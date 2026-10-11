"use client";

// "Take live" (staff, Super Admin): everything between a banker and live money in one place —
// onboarding approval, live mode, each payment account's go-live, and a real ₹1 payment
// (lib/take-live). Each button calls the existing route with its checks; a refused step shows why
// and, where a Super Admin may, takes a note to go ahead anyway — the same overrides as the
// individual pages, recorded the same way. Renders nothing once everything is live.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Circle, Loader2, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { IntentLiveTestCard } from "@/components/merchant/intent-live-test";
import { cn } from "@/lib/utils";
import { gateWords, nextOnboardingStep, takeLiveItems, type GoLiveAccount } from "@/lib/take-live";

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
        flow ? Promise.resolve(null) : fetch(`/api/merchants/${merchantId}/payin-flow`).then((r) => r.json()).catch(() => null),
      ]);
      const m = ((list.merchants ?? []) as Merchant[]).find((x) => x.id === merchantId || x.merchant_code === merchantCode) ?? null;
      return {
        m, live: String(act.status ?? "NOT_REQUESTED"), setupMissing: (act.setup_missing ?? []) as string[],
        accounts: (gl.accounts ?? []) as (GoLiveAccount & { checklist?: { key: string; label: string; done: boolean }[] })[],
        paidLive: ((tests.tests ?? []) as { status: string }[]).some((t) => t.status === "SUCCESS"),
        flow: (flow ?? (fl?.active === "INTENT" || fl?.flow === "INTENT" ? "INTENT" : "P2P")) as "P2P" | "INTENT",
      };
    },
    refetchInterval: 15_000,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [note, setNote] = useState("");
  const [risk, setRisk] = useState<"LOW" | "MEDIUM" | "HIGH">("LOW");
  const refresh = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ["merchant", merchantId] }); qc.invalidateQueries({ queryKey: ["merchants"] }); };

  const d = q.data;
  if (!d?.m) return q.isLoading ? null : null;
  const items = takeLiveItems(d.m, d.live, d.accounts, d.paidLive);
  if (!alwaysShow && items.every((i) => i.done)) return null;

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

  async function setAccountLive(a: GoLiveAccount) {
    setBusy(`ACCOUNT:${a.account}`); setMsg(null);
    for (const action of ["ping", "webhook", "status", "live"] as const) {
      const r = await post("/api/ops/gateway-golive", { merchant_id: merchantCode, gateway: a.gateway, account: a.account, action });
      if (!r.ok) {
        setMsg({ tone: "bad", text: action === "webhook" || action === "status"
          ? `${a.gateway}: ${r.d.error ?? "no confirmed real payment yet"}. Make the live test payment below, then try again.`
          : `${a.gateway} (${action}): ${r.d.error ?? `HTTP ${r.status}`}` });
        setBusy(null); refresh(); return;
      }
    }
    setMsg({ tone: "ok", text: `${a.gateway} is live.` }); setBusy(null); refresh();
  }

  const verifying = d.accounts.filter((a) => a.status === "VERIFYING");
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Rocket className="h-4 w-4" /> Take {merchantCode} live</CardTitle>
        <CardDescription>Everything between this banker and live money, in order. Each step runs the usual checks.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <ol className="space-y-3">
          {items.map((it) => (
            <li key={it.key} className="flex gap-3">
              {it.done ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-success)]" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-warning)]" />}
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
                  <Button size="sm" onClick={() => switchOnLive()} disabled={!!busy || !items[0].done}>
                    {busy === "LIVE_MODE" ? <><Loader2 className="h-4 w-4 animate-spin" /> Switching on…</> : "Switch on live mode"}
                  </Button>
                )}

                {it.key === "ACCOUNT" && verifying.map((a) => (
                  <div key={a.account} className="rounded-xl border border-[color:var(--color-border)] px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{a.gateway}{a.account !== "gateway_mid" && a.account_label ? ` · ${a.account_label}` : ""}</span>
                      <Button size="sm" variant="secondary" onClick={() => setAccountLive(a)} disabled={!!busy || !items[1].done}>
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

        {msg && (
          <div role="status" className={cn("rounded-xl border px-3 py-2", msg.tone === "ok"
            ? "border-[color:var(--color-success)] bg-[color:var(--color-success-muted)]" : "border-[color:var(--color-danger)] bg-[color:var(--color-danger-muted)]")}>{msg.text}</div>
        )}

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

        {items[1].done && (
          <div className="border-t border-[color:var(--color-border)] pt-4">
            <IntentLiveTestCard merchantId={merchantId} merchantCode={merchantCode} flow={d.flow} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
