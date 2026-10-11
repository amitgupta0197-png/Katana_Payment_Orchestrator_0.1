"use client";

// Banker onboarding, one question at a time (staff, Super Admin). Katana's banker model:
// P2P (scan and pay on the banker's own QR: BharatPe / Google Pay / PhonePe / Paytm / other; or
// scan, pay and verify — the quasi channel — through PayAtom) or Intent (a gateway confirms by
// callback). Rules and the setup calls are in lib/banker-wizard; this only asks, then runs the
// calls through the existing APIs and shows what each did.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { codeFromName } from "@/lib/merchant-code";
import { GATEWAYS, gatewayCheckoutMode, CHECKOUT_MODE_WORDS, type AuthModeId, type CredField } from "@/lib/pg-catalog";
import { P2P_APP_INFO, P2P_APPS, P2P_KIND_INFO, type P2pApp, type P2pKind } from "@/lib/p2p-method";
import {
  afterSteps, EMPTY_ANSWERS, stepProblem, wizardCalls, wizardSteps, type BankerType, type Env, type StepKey, type WizardAnswers,
} from "@/lib/banker-wizard";

const QUESTION: Record<StepKey, { rail: string; title: string; body: string }> = {
  merchant: { rail: "Merchant", title: "Which merchant is this banker for?", body: "The banker collects payments for this merchant and settles to it." },
  banker: { rail: "Banker", title: "Who is the banker?", body: "Name, a unique banker code, and where to reach them. A banker login is made for this email." },
  type: { rail: "P2P or Intent", title: "How will this banker take payments?", body: "P2P: customers pay the banker's own UPI ID / QR. Intent: a payment gateway takes the payment and confirms it by callback." },
  kind: { rail: "P2P channel", title: "Which P2P channel?", body: "Both put the money in the banker's own account. They differ in who gives the customer the QR and who confirms the payment." },
  app: { rail: "QR app", title: "Whose QR do customers scan?", body: "The banker's static QR comes from one payment app. The Katana agent on the banker's phone reads that app to confirm each payment." },
  upi: { rail: "UPI ID", title: "Which UPI ID do customers pay?", body: "The UPI ID on the banker's QR, exactly as the app shows it." },
  payatom: { rail: "PayAtom", title: "Connect PayAtom", body: "PayAtom gives the customer the payment link and verifies the payment; the money lands in the banker's own account. You can also connect it later." },
  gateway: { rail: "Gateway", title: "Which payment gateway?", body: "The gateway takes the customer's payment and confirms it to Katana by callback." },
  credentials: { rail: "Credentials", title: "Gateway credentials", body: "From the gateway's dashboard. Start with Test to check the connection; switch to Live on the banker page when ready." },
  review: { rail: "Review", title: "Check and create", body: "Nothing is created until you press Create banker." },
};

interface Provider { id: string; code: string; legal_name: string }
interface CallResult { key: string; label: string; ok: boolean | null; error?: string }
interface Done { id: string | null; code: string; login?: { email: string; password: string | null; existing: boolean } | null; bharatpe?: { api_key: string | null; secret: string | null } | null; results: CallResult[] }

const INTENT_GATEWAYS = GATEWAYS.filter((g) => g.payin.connector && g.id !== "PAYATOM");

export function BankerWizard({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [a, setA] = useState<WizardAnswers>(EMPTY_ANSWERS);
  const [at, setAt] = useState(0);
  const [codeTouched, setCodeTouched] = useState(false);
  const [running, setRunning] = useState<CallResult[] | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const set = (p: Partial<WizardAnswers>) => setA((x) => ({ ...x, ...p }));

  useEffect(() => { if (open) { setA(EMPTY_ANSWERS); setAt(0); setDone(null); setRunning(null); setCodeTouched(false); } }, [open]);

  const steps = useMemo(() => wizardSteps(a), [a]);
  const step = steps[Math.min(at, steps.length - 1)];
  const q = QUESTION[step];

  const providersQ = useQuery({
    queryKey: ["providers"], enabled: open,
    queryFn: async () => ((await (await fetch("/api/providers")).json()) as { providers: Provider[] }).providers ?? [],
  });
  const codeQ = useQuery({
    queryKey: ["banker-code", a.code.trim().toUpperCase()], enabled: open && a.code.trim().length >= 2,
    queryFn: async () => (await (await fetch(`/api/merchants/code?code=${encodeURIComponent(a.code.trim())}`)).json()) as { code: string; taken: boolean; free: string | null },
    staleTime: 10_000,
  });
  const gw = INTENT_GATEWAYS.find((g) => g.id === a.gateway) ?? null;
  const auth = gw?.payin.altAuth?.find((m) => m.id === a.gatewayAuth) ?? null;
  const gwFields: CredField[] = auth?.fields ?? gw?.payin.fields ?? [];

  const problem = stepProblem(step, a, { codeTaken: codeQ.data?.taken === true && codeQ.data.code === a.code.trim().toUpperCase(), gatewayFields: gwFields });

  const next = () => { if (problem) return; if (step === "review") { void run(); return; } setAt((i) => Math.min(i + 1, steps.length - 1)); panel.current?.scrollTo({ top: 0 }); };
  const back = () => setAt((i) => Math.max(0, i - 1));

  async function run() {
    const calls = wizardCalls(a);
    const results: CallResult[] = calls.map((c) => ({ key: c.key, label: c.label, ok: null }));
    setRunning([...results]);
    const out: Done = { id: null, code: a.code.trim().toUpperCase(), results };
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      try {
        const r = await fetch(c.path(out.id ?? ""), { method: c.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(c.body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? d.message ?? `HTTP ${r.status}`);
        if (c.key === "create") { out.id = d.id; out.login = d.login ?? null; }
        if (c.key === "bharatpe") out.bharatpe = { api_key: d.api_key ?? null, secret: d.secret ?? null };
        results[i] = { ...results[i], ok: true };
      } catch (e) {
        results[i] = { ...results[i], ok: false, error: (e as Error).message };
        setRunning([...results]);
        if (c.key === "create") return;           // nothing made: stay on review to fix it
        break;                                     // banker exists: finish the rest on its page
      }
      setRunning([...results]);
    }
    qc.invalidateQueries({ queryKey: ["merchants"] });
    setDone(out);
  }

  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (e.key === "Enter" && !done && !running && t.tagName !== "BUTTON" && t.tagName !== "SELECT" && t.tagName !== "TEXTAREA") { e.preventDefault(); next(); }
  };

  const createFailed = running?.[0]?.ok === false;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[980px] gap-0 overflow-hidden p-0 sm:p-0">
        <div className="grid h-[min(720px,92dvh)] grid-cols-1 md:grid-cols-[250px_1fr]" onKeyDown={onKey}>
          <aside className="hidden flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-surface-muted)] px-5 py-6 md:flex">
            <div className="text-xs text-[color:var(--color-text-muted)]">New banker</div>
            <div className="mt-1 break-words text-lg font-semibold leading-snug">{a.name.trim() || "Banker"}</div>
            <ol className="mt-6 space-y-1">
              {steps.map((s, i) => {
                const current = !done && i === at;
                const reachable = !done && !running && i <= at;
                const ans = answerFor(s, a, providersQ.data);
                return (
                  <li key={s}>
                    <button type="button" disabled={!reachable} onClick={() => setAt(i)}
                      className={cn("flex w-full gap-3 rounded-lg px-2 py-2 text-left transition-colors disabled:cursor-default",
                        current ? "bg-[color:var(--color-surface)]" : reachable && "hover:bg-[color:var(--color-surface)]")}>
                      <span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px]",
                        i < at || done ? "bg-[color:var(--color-success)] text-white"
                          : current ? "bg-[color:var(--color-brand)] text-[color:var(--color-brand-fg)]"
                          : "border border-[color:var(--color-border)] text-[color:var(--color-text-muted)]")}>
                        {i < at || done ? <Check className="h-3 w-3" /> : i + 1}
                      </span>
                      <span className="min-w-0">
                        <span className={cn("block text-sm", current ? "font-semibold" : "font-medium")}>{QUESTION[s].rail}</span>
                        {ans && (i < at || done) && <span className="block truncate text-xs text-[color:var(--color-text-muted)]">{ans}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </aside>

          <section className="flex min-h-0 flex-col">
            <div className="h-1 bg-[color:var(--color-border)] md:hidden" aria-hidden>
              <div className="h-1 bg-[color:var(--color-brand)] transition-[width]" style={{ width: `${((done ? steps.length : at) / steps.length) * 100}%` }} />
            </div>
            <div ref={panel} className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-7 sm:px-10">
              {done ? <Finished a={a} done={done} onClose={() => onOpenChange(false)} /> : (
                <div className="mx-auto max-w-[580px]">
                  <DialogTitle className="text-[26px] font-semibold leading-tight tracking-tight">{q.title}</DialogTitle>
                  <DialogDescription className="mt-2 text-[15px] leading-relaxed text-[color:var(--color-text-muted)]">{q.body}</DialogDescription>
                  <div className="mt-6 space-y-4">
                    {step === "merchant" && (
                      <Field label="Merchant">
                        <select value={a.providerId} onChange={(e) => set({ providerId: e.target.value })} autoFocus
                          className="flex h-10 w-full rounded-md border bg-[color:var(--color-surface)] px-3 text-sm">
                          <option value="">{providersQ.isLoading ? "Loading…" : "Choose a merchant"}</option>
                          {(providersQ.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.legal_name} · {p.code}</option>)}
                        </select>
                      </Field>
                    )}

                    {step === "banker" && (<>
                      <Field label="Banker name"><Input autoFocus value={a.name} placeholder="e.g. Mypay Traders" autoComplete="off"
                        onChange={(e) => set({ name: e.target.value, ...(codeTouched ? {} : { code: codeFromName(e.target.value) }) })} /></Field>
                      <Field label="Banker code" hint="Unique among bankers. Letters, digits, - and _.">
                        <Input value={a.code} autoComplete="off" onChange={(e) => { setCodeTouched(true); set({ code: e.target.value.toUpperCase() }); }} />
                      </Field>
                      {codeQ.data?.taken && codeQ.data.code === a.code.trim().toUpperCase() && (
                        <div role="alert" className="-mt-2 rounded-xl border border-[color:var(--color-danger)] bg-[color:var(--color-danger-muted)] px-4 py-2.5 text-sm">
                          {codeQ.data.code} is already a banker.{codeQ.data.free && <> <button type="button" className="font-semibold text-[color:var(--color-brand)] hover:underline"
                            onClick={() => { set({ code: codeQ.data!.free! }); setCodeTouched(true); }}>Use {codeQ.data.free}</button></>}
                        </div>
                      )}
                      <Field label="Contact email" hint="The banker signs in with this email."><Input type="email" value={a.email} placeholder="ops@banker.in" autoComplete="off" onChange={(e) => set({ email: e.target.value })} /></Field>
                      <Field label="Phone" hint="Optional."><Input value={a.phone} inputMode="tel" autoComplete="off" onChange={(e) => set({ phone: e.target.value })} /></Field>
                    </>)}

                    {step === "type" && (
                      <Choice<BankerType> value={a.type} onChange={(v) => set({ type: v, kind: null, app: null, gateway: null, connectLater: false })} options={[
                        { value: "P2P", title: "P2P banker", body: "Customers pay the banker's own UPI ID / QR. Confirmed from the banker's phone, or verified by a processor (quasi)." },
                        { value: "INTENT", title: "Intent banker", body: "A payment gateway (PayU, Cashfree, RubyVault, …) takes the payment and confirms it to Katana by callback." },
                      ]} />
                    )}

                    {step === "kind" && (
                      <Choice<P2pKind> value={a.kind} onChange={(v) => set({ kind: v, app: null, connectLater: false })} options={[
                        { value: "SCAN_PAY", title: P2P_KIND_INFO.SCAN_PAY.title, body: `${P2P_KIND_INFO.SCAN_PAY.line} BharatPe, Google Pay, PhonePe, Paytm or another static QR.` },
                        { value: "QUASI", title: `${P2P_KIND_INFO.QUASI.title} (quasi)`, body: `${P2P_KIND_INFO.QUASI.line} Through PayAtom.` },
                      ]} />
                    )}

                    {step === "app" && (
                      <Choice<P2pApp> value={a.app} onChange={(v) => set({ app: v })} options={P2P_APPS.map((p) => ({
                        value: p, title: P2P_APP_INFO[p].title,
                        body: p === "BHARATPE" ? "The agent reads BharatPe for Business and sends each payment with its UTR, signed with the BharatPe MID key made in the next step."
                          : p === "OTHER" ? "A bank QR or another app. Confirmed from the bank's credit SMS on the banker's phone (or Airtel / Pine Labs)."
                          : `The agent reads ${P2P_APP_INFO[p].agent} on the banker's phone.`,
                      }))} />
                    )}

                    {step === "upi" && (<>
                      <Field label={a.app === "BHARATPE" ? "BharatPe QR's UPI ID" : "UPI ID customers pay"}>
                        <Input autoFocus value={a.upiId} placeholder={a.app === "BHARATPE" ? "bharatpe…@unitype" : "shop@okaxis"} autoComplete="off" onChange={(e) => set({ upiId: e.target.value })} />
                      </Field>
                      {a.app === "BHARATPE" ? (<>
                        <Field label="BharatPe merchant ID" hint="Optional, digits only, as on the BharatPe dashboard."><Input value={a.bharatpeMid} inputMode="numeric" onChange={(e) => set({ bharatpeMid: e.target.value })} /></Field>
                        <EnvPick value={a.bharatpeEnv} onChange={(v) => set({ bharatpeEnv: v })} test="Test: confirms test orders only, no live money." live="Live: confirms real orders." />
                      </>) : (
                        <Field label="Name on the UPI ID" hint="Optional. Exactly as a UPI app shows it when paying this UPI ID."><Input value={a.payeeName} onChange={(e) => set({ payeeName: e.target.value })} /></Field>
                      )}
                    </>)}

                    {step === "payatom" && (<>
                      <Toggle on={a.connectLater} onChange={(v) => set({ connectLater: v })} title="Connect PayAtom later" body="Create the banker now and add PayAtom's details on its page." />
                      {!a.connectLater && (<>
                        <EnvPick value={a.payatom.env} onChange={(v) => set({ payatom: { ...a.payatom, env: v } })} test="Test (UAT) credentials." live="Live credentials." />
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Field label="PID"><Input value={a.payatom.pid} onChange={(e) => set({ payatom: { ...a.payatom, pid: e.target.value } })} /></Field>
                          <Field label="Secret key"><Input type="password" value={a.payatom.secret} autoComplete="new-password" onChange={(e) => set({ payatom: { ...a.payatom, secret: e.target.value } })} /></Field>
                          <Field label="API key (X-Api-Key)"><Input type="password" value={a.payatom.apiKey} autoComplete="new-password" onChange={(e) => set({ payatom: { ...a.payatom, apiKey: e.target.value } })} /></Field>
                          <Field label="API base URL"><Input value={a.payatom.apiBase} placeholder="https://…" onChange={(e) => set({ payatom: { ...a.payatom, apiBase: e.target.value } })} /></Field>
                          <Field label="Latitude"><Input value={a.payatom.latitude} placeholder="19.0760" onChange={(e) => set({ payatom: { ...a.payatom, latitude: e.target.value } })} /></Field>
                          <Field label="Longitude"><Input value={a.payatom.longitude} placeholder="72.8777" onChange={(e) => set({ payatom: { ...a.payatom, longitude: e.target.value } })} /></Field>
                        </div>
                      </>)}
                    </>)}

                    {step === "gateway" && (<>
                      <div role="radiogroup" className="grid gap-2.5 sm:grid-cols-2">
                        {INTENT_GATEWAYS.map((g) => {
                          const on = a.gateway === g.id && !a.connectLater;
                          const mode = gatewayCheckoutMode(g.id, null);
                          return (
                            <button key={g.id} type="button" role="radio" aria-checked={on}
                              onClick={() => set({ gateway: g.id, gatewayAuth: null, gatewayFields: {}, connectLater: false })}
                              className={cn("rounded-2xl border px-4 py-3 text-left transition-colors",
                                on ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)]" : "border-[color:var(--color-border)] hover:border-[color:var(--color-text-muted)]")}>
                              <span className="flex items-center gap-2 font-medium">
                                <span className="grid h-6 w-6 place-items-center rounded-md text-[11px] font-bold text-white" style={{ background: g.color }}>{g.name[0]}</span>{g.name}
                              </span>
                              <span className="mt-1 block text-xs text-[color:var(--color-text-muted)]">{mode ? CHECKOUT_MODE_WORDS[mode].label : ""}</span>
                            </button>
                          );
                        })}
                        <div className="rounded-2xl border border-dashed border-[color:var(--color-border)] px-4 py-3 opacity-60" aria-disabled>
                          <span className="font-medium">Easebuzz</span>
                          <span className="mt-1 block text-xs text-[color:var(--color-text-muted)]">Not connected yet: needs Easebuzz's API docs and test keys</span>
                        </div>
                      </div>
                      <Toggle on={a.connectLater} onChange={(v) => set({ connectLater: v, ...(v ? { gateway: null } : {}) })} title="Connect the gateway later" body="Create the banker now and connect its gateway on the &quot;Pays via gateway&quot; tab." />
                    </>)}

                    {step === "credentials" && gw && (<>
                      {gw.payin.altAuth?.length ? (
                        <Field label="Sign-in">
                          <select value={a.gatewayAuth ?? ""} onChange={(e) => set({ gatewayAuth: (e.target.value || null) as AuthModeId | null, gatewayFields: {} })}
                            className="flex h-10 w-full rounded-md border bg-[color:var(--color-surface)] px-3 text-sm">
                            <option value="">{gw.payin.defaultAuthLabel ?? "Default"}</option>
                            {gw.payin.altAuth.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                          </select>
                        </Field>
                      ) : null}
                      <EnvPick value={a.gatewayEnv} onChange={(v) => set({ gatewayEnv: v })} test={`${gw.payin.env.TEST}.`} live={`${gw.payin.env.PROD}. Starts in verification: small payments only until one is confirmed.`} />
                      {gwFields.map((f) => (
                        <Field key={f.name} label={f.label + (f.optional ? " (optional)" : "")}>
                          {f.options ? (
                            <select value={a.gatewayFields[f.name] ?? ""} onChange={(e) => set({ gatewayFields: { ...a.gatewayFields, [f.name]: e.target.value } })}
                              className="flex h-10 w-full rounded-md border bg-[color:var(--color-surface)] px-3 text-sm">
                              <option value="">Choose</option>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          ) : (
                            <Input type={f.secret ? "password" : "text"} autoComplete={f.secret ? "new-password" : "off"} placeholder={f.placeholder}
                              value={a.gatewayFields[f.name] ?? ""} onChange={(e) => set({ gatewayFields: { ...a.gatewayFields, [f.name]: e.target.value } })} />
                          )}
                        </Field>
                      ))}
                      {gw.payin.creds && <p className="text-xs text-[color:var(--color-text-muted)]">{gw.payin.creds}</p>}
                    </>)}

                    {step === "review" && (
                      <div className="space-y-4">
                        <dl className="divide-y divide-[color:var(--color-border)] rounded-2xl border border-[color:var(--color-border)] text-sm">
                          {steps.filter((s) => s !== "review").map((s) => (
                            <div key={s} className="flex gap-4 px-4 py-2.5">
                              <dt className="w-32 shrink-0 text-[color:var(--color-text-muted)]">{QUESTION[s].rail}</dt>
                              <dd className="min-w-0 break-words">{answerFor(s, a, providersQ.data) || "—"}</dd>
                            </div>
                          ))}
                        </dl>
                        <div>
                          <div className="mb-2 text-sm font-medium">What Create banker does</div>
                          <ol className="space-y-1.5 text-sm">
                            {(running ?? wizardCalls(a).map((c) => ({ key: c.key, label: c.label, ok: null } as CallResult))).map((r) => (
                              <li key={r.key} className="flex items-start gap-2">
                                {r.ok === true ? <Check className="mt-0.5 h-4 w-4 text-[color:var(--color-success)]" />
                                  : r.ok === false ? <X className="mt-0.5 h-4 w-4 text-[color:var(--color-danger)]" />
                                  : running ? <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-[color:var(--color-text-muted)]" />
                                  : <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[color:var(--color-border-strong)]" />}
                                <span>{r.label}{r.error && <span className="block text-xs text-[color:var(--color-danger)]">{r.error}</span>}</span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            {!done && (
              <footer className="flex items-center gap-3 border-t border-[color:var(--color-border)] px-6 py-4 sm:px-10">
                {at > 0 ? <Button variant="secondary" onClick={back} disabled={!!running && !createFailed}><ArrowLeft className="h-4 w-4" /> Back</Button>
                  : <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>}
                <span className="ml-auto hidden text-xs text-[color:var(--color-text-muted)] sm:inline" aria-live="polite">{problem ?? (step === "review" ? "" : "Press Enter to continue")}</span>
                <Button onClick={next} disabled={!!problem || (!!running && !createFailed)} className="ml-auto sm:ml-0">
                  {step === "review" ? (running && !createFailed ? "Creating…" : "Create banker") : "Continue"}
                </Button>
              </footer>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function answerFor(s: StepKey, a: WizardAnswers, providers?: Provider[]): string {
  switch (s) {
    case "merchant": { const p = providers?.find((x) => x.id === a.providerId); return p ? `${p.legal_name} · ${p.code}` : ""; }
    case "banker": return a.name.trim() ? `${a.name.trim()} · ${a.code.trim().toUpperCase()}` : "";
    case "type": return a.type === "P2P" ? "P2P banker" : a.type === "INTENT" ? "Intent banker" : "";
    case "kind": return a.kind ? P2P_KIND_INFO[a.kind].title : "";
    case "app": return a.app ? P2P_APP_INFO[a.app].title : "";
    case "upi": return a.upiId.trim() + (a.app === "BHARATPE" ? ` · ${a.bharatpeEnv === "PROD" ? "Live" : "Test"} MID` : "");
    case "payatom": return a.connectLater ? "Connect later" : `PID ${a.payatom.pid.trim()} · ${a.payatom.env === "PROD" ? "Live" : "Test"}`;
    case "gateway": return a.connectLater ? "Connect later" : (INTENT_GATEWAYS.find((g) => g.id === a.gateway)?.name ?? "");
    case "credentials": return a.gatewayEnv === "PROD" ? "Live credentials" : "Test credentials";
    case "review": return "";
  }
}

function Finished({ a, done, onClose }: { a: WizardAnswers; done: Done; onClose: () => void }) {
  const failed = done.results.find((r) => r.ok === false);
  return (
    <div className="mx-auto max-w-[580px] space-y-6">
      <div>
        <div className="flex items-center gap-2 text-[color:var(--color-success)]"><Check className="h-5 w-5" /><span className="font-semibold">Banker {done.code} created</span></div>
        <DialogTitle className="mt-2 text-[26px] font-semibold leading-tight tracking-tight">{failed ? "Created — one step needs finishing" : "Ready to set live"}</DialogTitle>
        <DialogDescription className="mt-2 text-[15px] text-[color:var(--color-text-muted)]">
          {failed ? `"${failed.label}" didn't go through: ${failed.error}. Finish it on the banker page.` : "Everything you chose is saved."}
        </DialogDescription>
      </div>
      <ol className="space-y-1.5 text-sm">
        {done.results.map((r) => (
          <li key={r.key} className="flex items-start gap-2">
            {r.ok ? <Check className="mt-0.5 h-4 w-4 text-[color:var(--color-success)]" /> : r.ok === false ? <X className="mt-0.5 h-4 w-4 text-[color:var(--color-danger)]" /> : <span className="mt-1.5 h-2 w-2 rounded-full bg-[color:var(--color-border-strong)]" />}
            <span className={cn(r.ok === null && "text-[color:var(--color-text-muted)]")}>{r.label}{r.ok === null ? " (not done)" : ""}</span>
          </li>
        ))}
      </ol>
      {(done.login?.password || done.bharatpe?.secret) && (
        <div className="space-y-2 rounded-2xl border border-[color:var(--color-warning)] bg-[color:var(--color-warning-muted)] px-4 py-3">
          <div className="text-sm font-semibold">Shown once — copy now</div>
          {done.login?.password && <><Secret label="Login email" value={done.login.email} /><Secret label="Password" value={done.login.password} /></>}
          {done.bharatpe?.api_key && <Secret label="BharatPe API key" value={done.bharatpe.api_key} />}
          {done.bharatpe?.secret && <Secret label="BharatPe secret" value={done.bharatpe.secret} />}
        </div>
      )}
      <div>
        <div className="mb-2 text-sm font-medium">Still to do</div>
        <ul className="list-disc space-y-1 pl-5 text-sm text-[color:var(--color-text-muted)]">{afterSteps(a).map((s) => <li key={s}>{s}</li>)}</ul>
      </div>
      <div className="flex gap-3">
        {done.id && <Button asChild><Link href={`/bankers/${done.id}?tab=${a.type === "INTENT" ? "intent" : "p2p"}`}>Open the banker</Link></Button>}
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-[color:var(--color-text-muted)]">{hint}</span>}
    </label>
  );
}

function Choice<T extends string>({ value, options, onChange }: { value: T | null; onChange: (v: T) => void; options: { value: T; title: string; body: string }[] }) {
  return (
    <div role="radiogroup" className="grid gap-2.5">
      {options.map((o, i) => {
        const on = value === o.value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
            className={cn("flex items-start gap-4 rounded-2xl border px-4 py-3.5 text-left transition-colors",
              on ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)]" : "border-[color:var(--color-border)] hover:border-[color:var(--color-text-muted)]")}>
            <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs",
              on ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand)] text-[color:var(--color-brand-fg)]" : "border-[color:var(--color-border)] text-[color:var(--color-text-muted)]")}>
              {on ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{o.title}</span>
              <span className="mt-0.5 block text-sm text-[color:var(--color-text-muted)]">{o.body}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function EnvPick({ value, onChange, test, live }: { value: Env; onChange: (v: Env) => void; test: string; live: string }) {
  return (
    <div>
      <div className="mb-1.5 text-sm font-medium">Mode</div>
      <div className="flex gap-2">
        {(["TEST", "PROD"] as Env[]).map((e) => (
          <Button key={e} type="button" size="sm" variant={value === e ? "default" : "secondary"} onClick={() => onChange(e)}>{e === "TEST" ? "Test" : "Live"}</Button>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-[color:var(--color-text-muted)]">{value === "TEST" ? test : live}</p>
    </div>
  );
}

function Toggle({ on, onChange, title, body }: { on: boolean; onChange: (v: boolean) => void; title: string; body: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-[color:var(--color-border)] px-4 py-3">
      <input type="checkbox" className="mt-1" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="block text-sm font-medium">{title}</span><span className="block text-xs text-[color:var(--color-text-muted)]">{body}</span></span>
    </label>
  );
}

function Secret({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-32 text-[color:var(--color-text-muted)]">{label}</span>
      <code className="break-all rounded-md bg-[color:var(--color-surface)] px-2 py-0.5 font-mono text-[13px]">{value}</code>
      <button type="button" aria-label={`Copy ${label}`} onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="rounded p-1 text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]">
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}
