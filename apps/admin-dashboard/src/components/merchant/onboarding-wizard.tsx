"use client";

// The merchant onboarding journey: one question at a time, with the route the money will take
// drawn as it is answered. Used to create a merchant, and to set up one that existed before
// services and flows were chosen (pre-filled with what its bankers actually did).
// The rules are in lib/merchant-services and lib/payin-flow; this only asks.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Check, Copy, Lightbulb } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ReadinessPreview } from "@/components/merchant/readiness";
import {
  SERVICES_LABEL, allowsPayin, allowsPayout, validateOnboardingChoice,
  type MerchantServices, type MerchantServicesSetting, type Suggestion, type MerchantEvidence,
} from "@/lib/merchant-services";
import { PAYIN_FLOW_LABEL, type OrderFlow, type PayinFlow, type MerchantFlow } from "@/lib/payin-flow";
import { MERCHANT_CODE, codeFromName } from "@/lib/merchant-code";
import { CHECKOUT_MODE_WORDS, type CheckoutMode } from "@/lib/pg-catalog";

// ── The answers ──────────────────────────────────────────────────────────────────────────

interface Answers {
  legal_name: string; code: string; kind: string;
  contact_email: string; contact_phone: string;
  services: MerchantServices | null; flow: PayinFlow | null; active: OrderFlow | null;
  /** How Intent customers pay: H2H (providers.needs_h2h on) or Redirect (off). Only asked for Intent. */
  checkout: CheckoutMode | null;
  merchant_login: boolean; dt_banker_login: boolean;
  first_banker: boolean; banker_code: string; banker_name: string; banker_email: string;
  note: string;
}
const EMPTY: Answers = {
  legal_name: "", code: "", kind: "PROVIDER", contact_email: "", contact_phone: "",
  services: null, flow: null, active: null, checkout: null,
  merchant_login: true, dt_banker_login: false, first_banker: true, banker_code: "", banker_name: "", banker_email: "",
  note: "",
};

type StepKey = "name" | "contact" | "services" | "flow" | "default" | "checkout" | "people" | "review";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE = MERCHANT_CODE;

function stepsFor(mode: "create" | "existing", a: Answers): StepKey[] {
  const s: StepKey[] = mode === "create" ? ["name", "contact", "services"] : ["services"];
  if (a.services && allowsPayin(a.services)) s.push("flow");
  if (a.services && allowsPayin(a.services) && a.flow === "BOTH") s.push("default");
  if (usesIntent(a)) s.push("checkout");
  if (mode === "create") s.push("people");
  s.push("review");
  return s;
}

/** Intent is on the merchant's choice: only then is H2H or Redirect asked (P2P always gives a UPI link). */
function usesIntent(a: Answers): boolean {
  return !!a.services && allowsPayin(a.services) && (a.flow === "INTENT" || a.flow === "BOTH");
}

function problemAt(step: StepKey, a: Answers): string | null {
  switch (step) {
    case "name":
      if (a.legal_name.trim().length < 2) return "Enter the merchant's legal name";
      if (!CODE.test(a.code.trim())) return "The code is 2 to 60 letters, digits, - or _";
      return null;
    case "contact":
      return EMAIL.test(a.contact_email.trim()) ? null : "Enter an email address we can reach them on";
    case "services": return a.services ? null : "Choose what they will use Katana for";
    case "flow": return a.flow ? null : "Choose how their customers will pay";
    case "default": return a.active ? null : "Choose the default flow";
    case "checkout": return a.checkout ? null : "Choose host-to-host or redirect";
    case "people":
      if (!a.first_banker) return null;
      if (!CODE.test(a.banker_code.trim())) return "The banker code is 2 to 60 letters, digits, - or _";
      if (a.banker_email.trim() && !EMAIL.test(a.banker_email.trim())) return "That banker email does not look right";
      return null;
    case "review":
      return a.services ? validateOnboardingChoice(a.services, allowsPayin(a.services) ? a.flow : null, a.flow === "BOTH" ? a.active : null) : "Choose the services";
  }
}

// ── The route map: where the money goes, drawn from the answers ──────────────────────────

function RouteMap({ a }: { a: Answers }) {
  const payin = !!a.services && allowsPayin(a.services);
  const payout = !!a.services && allowsPayout(a.services);
  const p2p = payin && (a.flow === "P2P" || a.flow === "BOTH");
  const intent = payin && (a.flow === "INTENT" || a.flow === "BOTH");
  const def = a.flow === "BOTH" ? a.active : null;
  // Faint until chosen, so the map shows what is possible and what this merchant does.
  const route = (on: boolean, color: string) => ({
    stroke: on ? color : "var(--color-border)", strokeWidth: on ? 2.5 : 1.5,
    strokeDasharray: on ? "0" : "4 5", className: "wz-route",
  });
  const node = (x: number, label: string, on: boolean) => (
    <g>
      <circle cx={x} cy={70} r={on ? 7 : 5} fill={on ? "var(--color-text)" : "var(--color-surface)"} stroke="var(--color-text-muted)" strokeWidth={1.5} className="wz-node" />
      <text x={x} y={100} textAnchor="middle" fontSize="12" fill={on ? "var(--color-text)" : "var(--color-text-muted)"}>{label}</text>
    </g>
  );
  const tag = (x: number, y: number, text: string, color: string) => (
    <text x={x} y={y} textAnchor="middle" fontSize="11" fontWeight={600} fill={color}>{text}</text>
  );
  return (
    <svg viewBox="0 0 560 112" role="img" className="h-auto w-full max-w-[560px]"
      aria-label={`Money route: ${!a.services ? "nothing chosen yet" : [payin && `pay-ins by ${a.flow ? PAYIN_FLOW_LABEL[a.flow] : "a flow not chosen yet"}`, payout && "payouts"].filter(Boolean).join(" and ")}`}>
      {/* P2P: the customer pays the banker's own UPI ID, straight across. */}
      <path d="M 60 70 L 360 70" fill="none" {...route(p2p, "var(--color-info)")} />
      {/* Intent: the customer pays through a gateway, which settles to the banker. */}
      <path d="M 60 70 C 120 18, 160 18, 210 18 C 260 18, 300 18, 360 70" fill="none" {...route(intent, "var(--color-brand)")} />
      {/* Payout: the banker's merchant pays a beneficiary. */}
      <path d="M 360 70 L 500 70" fill="none" {...route(payout, "var(--color-success)")} />
      <rect x={176} y={6} width={68} height={24} rx={12} fill="var(--color-surface)" stroke={intent ? "var(--color-brand)" : "var(--color-border)"} />
      <text x={210} y={22} textAnchor="middle" fontSize="11" fill={intent ? "var(--color-brand)" : "var(--color-text-muted)"}>gateway</text>
      {node(60, "Customer", payin)}
      {node(360, "Banker", !!a.services)}
      {node(500, "Beneficiary", payout)}
      {p2p && tag(210, 62, def === "P2P" ? "P2P · default" : "P2P", "var(--color-info)")}
      {intent && def === "INTENT" && <text x={252} y={11} fontSize="11" fontWeight={600} fill="var(--color-brand)">default</text>}
      {payout && tag(430, 62, "payout", "var(--color-success)")}
    </svg>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────────────────

function Choice<T extends string>({ value, options, onChange, suggested }: {
  value: T | null; onChange: (v: T) => void; suggested?: T | null;
  options: { value: T; title: string; body: string }[];
}) {
  return (
    <div role="radiogroup" className="grid gap-2.5">
      {options.map((o, i) => {
        const on = value === o.value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
            className={cn(
              "group flex items-start gap-4 rounded-2xl border px-4 py-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2",
              on ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)]"
                : "border-[color:var(--color-border)] hover:border-[color:var(--color-text-muted)]",
            )}>
            <span aria-hidden className={cn(
              "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums",
              on ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand)] text-[color:var(--color-brand-fg)]"
                : "border-[color:var(--color-border)] text-[color:var(--color-text-muted)]",
            )}>{on ? <Check className="h-3.5 w-3.5" /> : i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
                {o.title}
                {suggested === o.value && (
                  <span className="rounded-full bg-[color:var(--color-warning-muted)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--color-warning)]">Suggested</span>
                )}
              </span>
              <span className="mt-0.5 block text-sm leading-relaxed text-[color:var(--color-text-muted)]">{o.body}</span>
            </span>
          </button>
        );
      })}
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

function Toggle({ on, onChange, title, body }: { on: boolean; onChange: (v: boolean) => void; title: string; body: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className="flex w-full items-start gap-3 rounded-xl px-1 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2">
      <span aria-hidden className={cn("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors",
        on ? "bg-[color:var(--color-brand)]" : "bg-[color:var(--color-border)]")}>
        <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform", on ? "translate-x-[18px]" : "translate-x-0.5")} />
      </span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-[color:var(--color-text-muted)]">{body}</span>
      </span>
    </button>
  );
}

// ── The questions ────────────────────────────────────────────────────────────────────────

const QUESTION: Record<StepKey, { rail: string; title: string; body: string }> = {
  name: { rail: "Name", title: "What is the merchant called?", body: "The legal name as it appears on their registration. The code is how staff and the API refer to them." },
  contact: { rail: "Contact", title: "Who do we talk to?", body: "Their sign-in and account notices go to this email." },
  services: { rail: "Services", title: "What will they use Katana for?", body: "Their bankers take only what is chosen here. You can change it later." },
  flow: { rail: "How customers pay", title: "How will their customers pay?", body: "Choose the pay-in flow. A merchant can be on one or both." },
  default: { rail: "Default flow", title: "Which flow should orders take when they don't say?", body: "The P2P and Intent order APIs always use their own flow. The general order API and v2 don't name one, so they use this default." },
  checkout: { rail: "Intent checkout", title: "Will they show the UPI link on their own page?", body: "This decides which payment accounts their bankers can be given for Intent. You can change it later on the merchant's page." },
  people: { rail: "Logins", title: "Who needs a login?", body: "Logins get a one-time password, shown once on the last screen." },
  review: { rail: "Review", title: "Check everything, then confirm", body: "Nothing is saved until you confirm." },
};

function answerFor(step: StepKey, a: Answers): string | null {
  switch (step) {
    case "name": return a.legal_name.trim() ? `${a.legal_name.trim()}${a.code ? ` (${a.code})` : ""}` : null;
    case "contact": return a.contact_email.trim() || null;
    case "services": return a.services ? SERVICES_LABEL[a.services] : null;
    case "flow": return a.flow ? PAYIN_FLOW_LABEL[a.flow] : null;
    case "default": return a.active ? PAYIN_FLOW_LABEL[a.active] : null;
    case "checkout": return a.checkout ? CHECKOUT_MODE_WORDS[a.checkout].label : null;
    case "people": return [a.merchant_login && "Merchant", a.first_banker && (a.banker_code || "First banker"), a.dt_banker_login && "DT banker"].filter(Boolean).join(", ") || "None";
    case "review": return null;
  }
}

// ── The journey ──────────────────────────────────────────────────────────────────────────

interface Existing { id: string; name: string; services: MerchantServicesSetting; flow: MerchantFlow }
interface Created {
  id: string; code: string; services?: string;
  provider_login?: { email?: string; password?: string | null; existing?: boolean; error?: string };
  banker_login?: { email?: string; password?: string | null; existing?: boolean; error?: string; banker_id?: string };
  branch?: { merchant_code?: string; login?: { email?: string; password?: string | null; existing?: boolean }; error?: string };
  /** The merchant was created but its Intent checkout choice was not saved. */
  checkout_error?: string;
}

export function MerchantWizard({ open, onOpenChange, mode, merchant, remaining, onNext }: {
  open: boolean; onOpenChange: (v: boolean) => void;
  mode: "create" | "existing";
  /** existing: the merchant being set up. */
  merchant?: Existing;
  /** existing: how many more merchants have nothing selected, to offer the next one. */
  remaining?: number;
  onNext?: () => void;
}) {
  const qc = useQueryClient();
  const [a, setA] = useState<Answers>(EMPTY);
  const [at, setAt] = useState(0);
  const [done, setDone] = useState<Created | { saved: true } | null>(null);
  const [codeTouched, setCodeTouched] = useState(false);
  // The code must be one no merchant has: checked when the name step is left, and offered by Generate.
  const [codeNote, setCodeNote] = useState<{ text: string; use?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const askCode = async (name: string, code: string) => {
    const r = await fetch(`/api/providers/code?name=${encodeURIComponent(name)}&code=${encodeURIComponent(code)}`);
    if (!r.ok) throw new Error("could not check the code");
    return (await r.json()) as { suggestion: string | null; available: boolean | null };
  };
  const generate = async () => {
    setCodeNote(null);
    try {
      const d = await askCode(a.legal_name, "");
      if (d.suggestion) { set({ code: d.suggestion }); setCodeTouched(false); setCodeNote({ text: `${d.suggestion} is free.` }); }
      else setCodeNote({ text: "Enter the legal name first: the code is built from it." });
    } catch (e) { setCodeNote({ text: (e as Error).message }); }
  };
  const panel = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<Answers>) => setA((p) => ({ ...p, ...patch }));

  // What an existing merchant most likely is, from what its bankers actually did.
  const sug = useQuery({
    queryKey: ["merchant-suggestion", merchant?.id],
    enabled: open && mode === "existing" && !!merchant,
    queryFn: async () => {
      const r = await fetch(`/api/providers/${merchant!.id}/onboarding-choice?suggest=1`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { suggestion: Suggestion; evidence: MerchantEvidence };
    },
  });
  const suggestion = sug.data?.suggestion ?? null;

  // An existing merchant's saved H2H choice. Off with no history means nobody chose yet: asked again.
  const h2h = useQuery({
    queryKey: ["provider", merchant?.id, "h2h"],
    enabled: open && mode === "existing" && !!merchant,
    queryFn: async () => {
      const r = await fetch(`/api/providers/${merchant!.id}/h2h`);
      if (!r.ok) return null;
      return (await r.json()) as { needs_h2h: boolean; history: unknown[] };
    },
  });
  useEffect(() => {
    if (!open || mode !== "existing" || !h2h.data) return;
    const saved: CheckoutMode | null = h2h.data.needs_h2h ? "H2H" : h2h.data.history.length ? "REDIRECT" : null;
    if (saved) setA((p) => (p.checkout ? p : { ...p, checkout: saved }));
  }, [open, mode, h2h.data]);

  // A fresh start each time it opens; an existing merchant starts from its saved choice, or
  // from the suggestion when nothing is saved.
  useEffect(() => {
    if (!open) return;
    setAt(0); setDone(null); setCodeTouched(false); setCodeNote(null);
    if (mode === "existing" && merchant) {
      setA({
        ...EMPTY,
        services: merchant.services === "UNSET" ? null : merchant.services,
        flow: merchant.flow.flow === "UNSET" ? null : merchant.flow.flow,
        active: merchant.flow.active,
      });
    } else setA(EMPTY);
  }, [open, mode, merchant?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open || mode !== "existing" || !suggestion || !merchant) return;
    if (merchant.services === "UNSET" && merchant.flow.flow === "UNSET" && suggestion.services)
      setA((p) => (p.services ? p : { ...p, services: suggestion.services, flow: suggestion.flow, active: suggestion.active }));
  }, [open, mode, suggestion, merchant]);

  const steps = useMemo(() => stepsFor(mode, a), [mode, a]);
  const step = steps[Math.min(at, steps.length - 1)];

  // The code is checked as it is typed. A code another merchant has cannot be used: the alert
  // says so and Continue stays off until the code is changed.
  const [taken, setTaken] = useState<{ code: string; free: string | null } | null>(null);
  useEffect(() => {
    if (mode !== "create" || step !== "name") return;
    const code = a.code.trim();
    if (!CODE.test(code)) { setTaken(null); return; }
    const t = setTimeout(() => {
      askCode(a.legal_name, code)
        .then((d) => setTaken(d.available === false
          ? { code, free: d.suggestion && d.suggestion.toUpperCase() !== code.toUpperCase() ? d.suggestion : null } : null))
        .catch(() => setTaken(null));
    }, 350);
    return () => clearTimeout(t);
  }, [mode, step, a.code, a.legal_name]); // eslint-disable-line react-hooks/exhaustive-deps
  const codeTaken = step === "name" && !!taken && taken.code.toUpperCase() === a.code.trim().toUpperCase();
  const problem = problemAt(step, a) ?? (codeTaken ? `${taken!.code} is already used by another merchant` : null);
  const showMap = step === "services" || step === "flow" || step === "default" || step === "checkout" || step === "review";
  const primary = useRef<HTMLButtonElement>(null);
  // The first field or the chosen answer; on the review, the confirm button, so Enter confirms.
  const focusQuestion = () => requestAnimationFrame(() => {
    const el = step === "review" && !done ? primary.current
      : panel.current?.querySelector<HTMLElement>("input, [role=radio][aria-checked=true], [role=radio], [role=switch], a, button");
    el?.focus();
  });
  useEffect(() => { if (open) focusQuestion(); }, [step, done, open]); // eslint-disable-line react-hooks/exhaustive-deps

  // The Intent checkout is providers.needs_h2h (lib/checkout-mode-store), saved after the merchant.
  // Returns why it was not saved, or null.
  const saveCheckout = async (providerId: string): Promise<string | null> => {
    if (!usesIntent(a) || !a.checkout) return null;
    try {
      const r = await fetch(`/api/providers/${providerId}/h2h`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ needs_h2h: a.checkout === "H2H", note: mode === "create" ? "chosen when the merchant was created" : a.note.trim() || undefined }),
      });
      if (r.ok) return null;
      const d = await r.json().catch(() => ({}));
      return d.error ?? `HTTP ${r.status}`;
    } catch (e) { return (e as Error).message; }
  };

  const save = useMutation({
    mutationFn: async () => {
      const choice = {
        services: a.services!,
        ...(a.services !== "PAYOUT" && a.flow ? { payin_flow: a.flow } : {}),
        ...(a.services !== "PAYOUT" && a.flow === "BOTH" && a.active ? { payin_active_flow: a.active } : {}),
      };
      if (mode === "existing") {
        const r = await fetch(`/api/providers/${merchant!.id}/onboarding-choice`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...choice, note: a.note.trim() || undefined }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Could not save");
        const h = await saveCheckout(merchant!.id);
        if (h) throw new Error(`Services and flow saved, but not the Intent checkout: ${h}`);
        return { saved: true } as const;
      }
      const r = await fetch("/api/providers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: a.code.trim(), legal_name: a.legal_name.trim(), kind: a.kind, create_only: true,
          contact_email: a.contact_email.trim(), ...(a.contact_phone.trim() ? { contact_phone: a.contact_phone.trim() } : {}),
          ...choice,
          create_provider_login: a.merchant_login,
          ...(a.dt_banker_login ? { create_banker_login: true } : {}),
          ...(a.first_banker ? { initial_branch: {
            merchant_code: a.banker_code.trim(), legal_name: a.banker_name.trim() || `${a.legal_name.trim()} banker`,
            ...(a.banker_email.trim() ? { contact_email: a.banker_email.trim() } : {}),
          } } : {}),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Could not create the merchant");
      const h = d.id ? await saveCheckout(d.id) : null;
      return { ...d, ...(h ? { checkout_error: h } : {}) } as Created;
    },
    onSuccess: (d) => {
      setDone(d);
      toast.success(mode === "create" ? "Merchant created" : "Saved", { description: mode === "create" ? a.legal_name : merchant?.name });
      for (const k of ["providers", "merchant-readiness", "merchant-services", "payin-flow", "payin-flows"]) qc.invalidateQueries({ queryKey: [k] });
      qc.invalidateQueries({ queryKey: ["provider"] });
    },
    onError: (e: Error) => toast.error(mode === "create" ? "Not created" : "Not saved", { description: e.message }),
  });

  const next = async () => {
    if (problem || save.isPending || checking) return;
    if (step === "review") { save.mutate(); return; }
    if (step === "name") {
      // A code another merchant has would be refused at the end: catch it here.
      setChecking(true);
      try {
        const d = await askCode(a.legal_name, a.code.trim());
        if (d.available === false) {
          const free = d.suggestion && d.suggestion.toUpperCase() !== a.code.trim().toUpperCase() ? d.suggestion : null;
          setTaken({ code: a.code.trim(), free });
          return;
        }
      } catch { /* could not check: the server refuses a taken code when the merchant is created */ }
      finally { setChecking(false); }
    }
    setAt((i) => Math.min(i + 1, steps.length - 1));
  };
  const back = () => setAt((i) => Math.max(0, i - 1));
  const goTo = (s: StepKey) => { const i = steps.indexOf(s); if (i >= 0) setAt(i); };

  // Enter on an answer chooses it and moves on; the move waits for the choice to be applied.
  const advance = useRef(false);
  useEffect(() => {
    if (!advance.current) return;
    advance.current = false;
    if (!problemAt(step, a)) setAt((i) => Math.min(i + 1, steps.length - 1));
  }, [a, step, steps.length]);

  const onKey = (e: React.KeyboardEvent) => {
    if (done) return;
    const target = e.target as HTMLElement;
    if (e.key === "Enter") {
      if (target.getAttribute("role") === "radio") {
        e.preventDefault();
        if (target.getAttribute("aria-checked") === "true") next();
        else { advance.current = true; target.click(); }
        return;
      }
      if (target.tagName !== "BUTTON" && target.tagName !== "SELECT" && target.tagName !== "A") { e.preventDefault(); next(); }
      return;
    }
    // Number keys pick an answer on a question with choices, and put the focus on it.
    if (/^[1-3]$/.test(e.key) && target.tagName !== "INPUT") {
      const radio = panel.current?.querySelectorAll<HTMLElement>("[role=radio]")[Number(e.key) - 1];
      if (radio) { radio.click(); radio.focus(); }
    }
  };

  const title = mode === "create" ? (a.legal_name.trim() || "New merchant") : merchant?.name ?? "";
  const q = QUESTION[step];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[980px] gap-0 overflow-hidden p-0 sm:p-0"
        // Start in the question, not on the step list: the first field, or the chosen answer.
        onOpenAutoFocus={(e) => { e.preventDefault(); focusQuestion(); }}>
        <div className="grid h-[min(700px,90dvh)] grid-cols-1 md:grid-cols-[250px_1fr]" onKeyDown={onKey}>
          {/* The journey: every question in order, with its answer once given. */}
          <aside className="hidden flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-surface-muted)] px-5 py-6 md:flex">
            <div className="text-xs text-[color:var(--color-text-muted)]">{mode === "create" ? "Create merchant" : "Set up merchant"}</div>
            <div className="mt-1 break-words text-lg font-semibold leading-snug">{title}</div>
            <ol className="mt-6 space-y-1">
              {steps.map((s, i) => {
                const ans = answerFor(s, a);
                const current = !done && i === at;
                const reachable = !done && i <= at;
                return (
                  <li key={s}>
                    <button type="button" disabled={!reachable} onClick={() => setAt(i)} aria-current={current ? "step" : undefined}
                      className={cn("flex w-full gap-3 rounded-lg px-2 py-2 text-left transition-colors disabled:cursor-default",
                        current ? "bg-[color:var(--color-surface)]" : reachable && "hover:bg-[color:var(--color-surface)]")}>
                      <span aria-hidden className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] tabular-nums",
                        i < at || done ? "bg-[color:var(--color-success)] text-white"
                          : current ? "bg-[color:var(--color-brand)] text-[color:var(--color-brand-fg)]"
                          : "border border-[color:var(--color-border)] text-[color:var(--color-text-muted)]")}>
                        {i < at || done ? <Check className="h-3 w-3" /> : i + 1}
                      </span>
                      <span className="min-w-0">
                        <span className={cn("block text-sm", current ? "font-semibold" : "font-medium", !reachable && !done && "text-[color:var(--color-text-muted)]")}>{QUESTION[s].rail}</span>
                        {ans && (i < at || done) && <span className="block truncate text-xs text-[color:var(--color-text-muted)]">{ans}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </aside>

          <section className="flex min-h-0 flex-col">
            {/* The progress, for narrow screens where the journey is hidden. */}
            <div className="h-1 bg-[color:var(--color-border)] md:hidden" aria-hidden>
              <div className="h-1 bg-[color:var(--color-brand)] transition-[width]" style={{ width: `${((done ? steps.length : at) / steps.length) * 100}%` }} />
            </div>

            <div ref={panel} key={done ? "done" : step} className="wz-panel min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-7 sm:px-10">
              {done ? (
                <Finished mode={mode} a={a} done={done} merchant={merchant} remaining={remaining}
                  onClose={() => onOpenChange(false)} onNext={onNext} />
              ) : (
                <div className="mx-auto max-w-[560px]">
                  {showMap && <div className="mb-6"><RouteMap a={a} /></div>}
                  <DialogTitle className="text-[26px] font-semibold leading-tight tracking-tight">{q.title}</DialogTitle>
                  <DialogDescription className="mt-2 text-[15px] leading-relaxed text-[color:var(--color-text-muted)]">{q.body}</DialogDescription>

                  <div className="mt-6 space-y-4">
                    {step === "name" && (
                      <>
                        <Field label="Legal name">
                          <Input value={a.legal_name} placeholder="e.g. Acme Retail Pvt Ltd" autoComplete="off"
                            onChange={(e) => { setCodeNote(null); set({ legal_name: e.target.value, ...(codeTouched ? {} : { code: codeFromName(e.target.value) }) }); }} />
                        </Field>
                        <Field label="Code" hint="Built from the name and unique among merchants. Letters, digits, - and _.">
                          <div className="flex gap-2">
                            <Input value={a.code} autoComplete="off" className="flex-1"
                              onChange={(e) => { setCodeTouched(true); setCodeNote(null); set({ code: e.target.value.toUpperCase() }); }} />
                            <Button type="button" variant="secondary" onClick={generate} disabled={!a.legal_name.trim()}>Generate</Button>
                          </div>
                        </Field>
                        {codeTaken && (
                          <div role="alert" className="-mt-1 rounded-xl border border-[color:var(--color-danger)] bg-[color:var(--color-danger-muted)] px-4 py-3 text-sm">
                            <div className="font-semibold text-[color:var(--color-danger)]">{taken!.code} is already used by another merchant</div>
                            <div className="mt-0.5 text-[color:var(--color-text)]">Two merchants cannot share a code. Choose another one{taken!.free ? "," : "."}
                              {taken!.free && (
                                <> or <button type="button" className="font-semibold text-[color:var(--color-brand)] hover:underline"
                                  onClick={() => { set({ code: taken!.free! }); setCodeTouched(false); setCodeNote({ text: `${taken!.free} is free.` }); }}>
                                  use {taken!.free}</button>.</>
                              )}
                            </div>
                          </div>
                        )}
                        {!codeTaken && codeNote && (
                          <p role="status" className="-mt-2 flex flex-wrap items-center gap-2 text-sm text-[color:var(--color-text-muted)]">
                            {codeNote.text}
                            {codeNote.use && (
                              <button type="button" className="font-medium text-[color:var(--color-brand)] hover:underline"
                                onClick={() => { set({ code: codeNote.use! }); setCodeTouched(false); setCodeNote({ text: `${codeNote.use} is free.` }); }}>
                                Use {codeNote.use}
                              </button>
                            )}
                          </p>
                        )}
                        <Field label="Kind">
                          <select value={a.kind} onChange={(e) => set({ kind: e.target.value })}
                            className="flex h-9 w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-1 text-sm">
                            <option value="PROVIDER">Merchant</option><option value="AGENT">Agent</option>
                            <option value="PARTNER">Partner</option><option value="FRANCHISE">Franchise</option>
                          </select>
                        </Field>
                      </>
                    )}

                    {step === "contact" && (
                      <>
                        <Field label="Email"><Input type="email" value={a.contact_email} placeholder="ops@merchant.com" autoComplete="off" onChange={(e) => set({ contact_email: e.target.value })} /></Field>
                        <Field label="Phone" hint="Optional."><Input value={a.contact_phone} inputMode="tel" autoComplete="off" onChange={(e) => set({ contact_phone: e.target.value })} /></Field>
                      </>
                    )}

                    {step === "services" && (
                      <>
                        {mode === "existing" && <SuggestionNote loading={sug.isLoading} s={suggestion} e={sug.data?.evidence} />}
                        <Choice<MerchantServices> value={a.services} suggested={mode === "existing" ? suggestion?.services : null}
                          onChange={(v) => set(v === "PAYOUT" ? { services: v, flow: null, active: null } : { services: v })}
                          options={[
                            { value: "PAYIN", title: "Collect payments", body: "Customers pay the merchant. No payouts." },
                            { value: "PAYOUT", title: "Send payouts", body: "The merchant pays beneficiaries. It takes no pay-in orders." },
                            { value: "BOTH", title: "Both", body: "Collect payments and send payouts." },
                          ]} />
                      </>
                    )}

                    {step === "flow" && (
                      <Choice<PayinFlow> value={a.flow} suggested={mode === "existing" ? suggestion?.flow : null}
                        onChange={(v) => set({ flow: v, active: v === "BOTH" ? a.active : null })}
                        options={[
                          { value: "P2P", title: "P2P", body: "The customer pays the banker's own UPI ID. Confirmed when the credit shows in the bank account." },
                          { value: "INTENT", title: "Intent", body: "A payment gateway takes the payment and confirms it." },
                          { value: "BOTH", title: "Both", body: "Set up for each. You choose a default for orders that don't name a flow." },
                        ]} />
                    )}

                    {step === "default" && (
                      <Choice<OrderFlow> value={a.active} suggested={mode === "existing" ? suggestion?.active : null}
                        onChange={(v) => set({ active: v })}
                        options={[
                          { value: "P2P", title: "P2P by default", body: "Orders that don't name a flow go to the banker's own UPI ID." },
                          { value: "INTENT", title: "Intent by default", body: "Orders that don't name a flow go through the payment gateway." },
                        ]} />
                    )}

                    {step === "checkout" && (
                      <Choice<CheckoutMode> value={a.checkout}
                        onChange={(v) => set({ checkout: v })}
                        options={[
                          { value: "H2H", title: "Host-to-host (H2H)", body: "The order API returns the UPI link and QR, and they show it on their own page. Their bankers can only be given payment accounts that send that link." },
                          { value: "REDIRECT", title: "Redirect is fine", body: "They send the customer to pay_url, who pays on a hosted payment page. Any payment account can be used." },
                        ]} />
                    )}

                    {step === "people" && (
                      <div className="space-y-1">
                        <Toggle on={a.merchant_login} onChange={(v) => set({ merchant_login: v })}
                          title="Merchant login" body={`Signs in to the merchant portal as ${a.contact_email.trim() || "the contact email"}.`} />
                        <Toggle on={a.first_banker} onChange={(v) => set({ first_banker: v })}
                          title="Add the first banker now" body="A banker takes the orders. You can add more later from the merchant's page." />
                        {a.first_banker && (
                          <div className="grid gap-3 py-2 pl-12 sm:grid-cols-2">
                            <Field label="Banker code"><Input value={a.banker_code} placeholder="e.g. BR-001" autoComplete="off" onChange={(e) => set({ banker_code: e.target.value.toUpperCase() })} /></Field>
                            <Field label="Banker name"><Input value={a.banker_name} placeholder={`${a.legal_name.trim() || "Merchant"} banker`} autoComplete="off" onChange={(e) => set({ banker_name: e.target.value })} /></Field>
                            <div className="sm:col-span-2">
                              <Field label="Banker email" hint="Their banker portal login. Leave blank to use the contact email.">
                                <Input type="email" value={a.banker_email} autoComplete="off" onChange={(e) => set({ banker_email: e.target.value })} />
                              </Field>
                            </div>
                          </div>
                        )}
                        <Toggle on={a.dt_banker_login} onChange={(v) => set({ dt_banker_login: v })}
                          title="DT banker login" body="Only for merchants in the DT business. Uses the merchant code as the banker id." />
                      </div>
                    )}

                    {step === "review" && (
                      <div className="space-y-5">
                        <dl className="divide-y divide-[color:var(--color-border)] rounded-2xl border border-[color:var(--color-border)]">
                          {steps.filter((s) => s !== "review").map((s) => (
                            <div key={s} className="flex items-start gap-4 px-4 py-3">
                              <dt className="w-36 shrink-0 text-sm text-[color:var(--color-text-muted)]">{QUESTION[s].rail}</dt>
                              <dd className="min-w-0 flex-1 break-words text-sm font-medium">{answerFor(s, a)}</dd>
                              <button type="button" onClick={() => goTo(s)} className="text-sm text-[color:var(--color-brand)] hover:underline">Change</button>
                            </div>
                          ))}
                        </dl>
                        {mode === "existing" && merchant && !problem && (
                          <ReadinessPreview providerId={merchant.id} enabled={open}
                            services={a.services} flow={a.services === "PAYOUT" ? "UNSET" : a.flow} active={a.active} />
                        )}
                        {mode === "existing" && (
                          <Field label="Reason" hint="Optional. Kept in the merchant's history.">
                            <Input value={a.note} maxLength={300} onChange={(e) => set({ note: e.target.value })} placeholder="e.g. confirmed with the merchant on a call" />
                          </Field>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {!done && (
              <footer className="flex items-center gap-3 border-t border-[color:var(--color-border)] px-6 py-4 sm:px-10">
                {at > 0
                  ? <Button variant="secondary" onClick={back}><ArrowLeft className="h-4 w-4" /> Back</Button>
                  : <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>}
                <span className="ml-auto hidden text-xs text-[color:var(--color-text-muted)] sm:inline" aria-live="polite">
                  {problem ?? (step === "review" ? "" : "Press Enter to continue")}
                </span>
                <Button ref={primary} onClick={next} disabled={!!problem || save.isPending || checking} className="ml-auto sm:ml-0">
                  {step === "review" ? (save.isPending ? (mode === "create" ? "Creating…" : "Saving…") : mode === "create" ? "Create merchant" : "Save") : "Continue"}
                </Button>
              </footer>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SuggestionNote({ loading, s, e }: { loading: boolean; s: Suggestion | null; e?: MerchantEvidence }) {
  if (loading) return <p className="text-sm text-[color:var(--color-text-muted)]">Looking at what this merchant's bankers have done…</p>;
  if (!s) return null;
  return (
    <div className="flex gap-3 rounded-2xl border border-[color:var(--color-border)] px-4 py-3 text-sm">
      <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-warning)]" aria-hidden />
      <div>
        {s.reasons.length ? (
          <>
            <div className="font-medium">Suggested from what its {e?.bankers === 1 ? "banker" : `${e?.bankers ?? ""} bankers`} did</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[color:var(--color-text-muted)]">{s.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          </>
        ) : (
          <div className="text-[color:var(--color-text-muted)]">No orders, payouts or setup to go on{e && !e.bankers ? ": this merchant has no bankers yet" : ""}. Choose with the merchant.</div>
        )}
      </div>
    </div>
  );
}

function Secret({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-[color:var(--color-text-muted)]">{label}</span>
      <code className="rounded-md bg-[color:var(--color-surface-muted)] px-2 py-0.5 font-mono text-[13px]">{value}</code>
      <button type="button" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="rounded p-1 text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]">
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function Finished({ mode, a, done, merchant, remaining, onClose, onNext }: {
  mode: "create" | "existing"; a: Answers; done: Created | { saved: true }; merchant?: Existing;
  remaining?: number; onClose: () => void; onNext?: () => void;
}) {
  const created = "id" in done ? done : null;
  const name = mode === "create" ? a.legal_name.trim() : merchant?.name ?? "";
  const providerId = created?.id ?? merchant?.id;
  const payin = !!a.services && allowsPayin(a.services);
  const usesP2P = payin && (a.flow === "P2P" || a.flow === "BOTH");
  const usesIntent = payin && (a.flow === "INTENT" || a.flow === "BOTH");
  const nextSteps = [
    usesP2P && "Save each banker's settlement UPI ID (banker page → Collection).",
    usesIntent && (a.checkout === "H2H"
      ? "Connect each banker's pay-in gateway with an H2H account: PayU Key + Salt, Razorpay, Cashfree, PhonePe, Paytm or PayAtom (banker page → Pays via gateway)."
      : "Connect each banker's pay-in gateway (banker page → Pays via gateway)."),
    a.services && allowsPayout(a.services) && "Optional: connect a payout gateway; without one, payouts are paid from the Katana balance.",
    mode === "create" && a.first_banker && "Take the first banker through onboarding to go-live.",
  ].filter(Boolean) as string[];
  const logins = created ? [
    created.provider_login && !created.provider_login.error && { who: "Merchant", ...created.provider_login },
    created.branch?.login && { who: `Banker ${created.branch.merchant_code ?? ""}`, ...created.branch.login },
    created.banker_login && !created.banker_login.error && { who: "DT banker", ...created.banker_login },
  ].filter(Boolean) as { who: string; email?: string; password?: string | null; existing?: boolean }[] : [];
  const failed = created ? [created.provider_login?.error, created.banker_login?.error, created.branch?.error,
    created.checkout_error && `Intent checkout not saved (${created.checkout_error}); set it on the merchant's page`].filter(Boolean) as string[] : [];

  return (
    <div className="mx-auto max-w-[560px]">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--color-success)] text-white"><Check className="h-6 w-6" /></div>
      <DialogTitle className="mt-5 text-[26px] font-semibold leading-tight tracking-tight">
        {mode === "create" ? `${name} is created` : `${name} is set up`}
      </DialogTitle>
      <DialogDescription className="mt-2 text-[15px] text-[color:var(--color-text-muted)]">
        {SERVICES_LABEL[a.services ?? "UNSET"]}{payin && a.flow ? `, ${PAYIN_FLOW_LABEL[a.flow]}${a.flow === "BOTH" && a.active ? ` with ${PAYIN_FLOW_LABEL[a.active]} by default` : ""}` : ""}{usesIntent && a.checkout ? `, Intent checkout ${CHECKOUT_MODE_WORDS[a.checkout].label.toLowerCase()}` : ""}.
      </DialogDescription>

      {logins.length > 0 && (
        <div className="mt-6 space-y-3 rounded-2xl border border-[color:var(--color-border)] p-4">
          <div className="text-sm font-medium">Logins: share these now. One-time passwords are not shown again.</div>
          {logins.map((l) => (
            <div key={l.who} className="space-y-1">
              <div className="text-sm font-semibold">{l.who}</div>
              {l.email && <Secret label="Email" value={l.email} />}
              {l.password ? <Secret label="Password" value={l.password} /> : <div className="text-xs text-[color:var(--color-text-muted)]">Existing account: signs in with its current password.</div>}
            </div>
          ))}
        </div>
      )}
      {failed.length > 0 && <p role="alert" className="mt-4 text-sm text-[color:var(--color-danger)]">Not done: {failed.join("; ")}</p>}

      {nextSteps.length > 0 && (
        <div className="mt-6">
          <div className="text-sm font-medium">Next</div>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-[color:var(--color-text-muted)]">{nextSteps.map((s) => <li key={s}>{s}</li>)}</ol>
        </div>
      )}

      <div className="mt-8 flex flex-wrap gap-2">
        {providerId && <Button asChild variant="secondary"><Link href={`/merchants/${providerId}`} onClick={onClose}>Open the merchant</Link></Button>}
        {mode === "existing" && onNext && (remaining ?? 0) > 0
          ? <Button onClick={onNext}>Set up the next merchant ({remaining} left)</Button>
          : <Button onClick={onClose}>Done</Button>}
      </div>
    </div>
  );
}
