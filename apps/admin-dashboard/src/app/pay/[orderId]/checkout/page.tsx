"use client";

// KATANA HOSTED CHECKOUT — quasi-headless (P2P method HEADLESS, lib/headless). PUBLIC, standalone
// (/pay is in STANDALONE_PREFIXES and the middleware's public UI prefixes): the merchant's app
// opens this URL in a WebView with no browser chrome. The order id in the URL is the capability.
//
//   PSP selector (PhonePe / Paytm, pre-selected from the customer's UPI ID) · who is paid ·
//   amount and note to confirm · Pay
//
// Pay asks the chosen app's PSP for the UPI intent (POST /api/pay-status/{id}/start) and
// navigates to the app link. The native shell intercepts phonepe:// / paytmmp:// / upi:// and
// hands it to the OS; the WebView never opens the app in-frame. When the payment is final the page
// tells the shell (postMessage on every bridge below) and, with ?embed=1, navigates to
// katana://checkout/done?… so the shell can close the WebView. The status shown here is UX only:
// the PSP's webhook to Katana, and Katana's signed callback to the merchant, are the truth.

import { use, useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Lock, ShieldCheck, X, Clock } from "lucide-react";
import { PaytmLogo, PhonePeLogo } from "@/components/icons/upi-apps";

type Psp = "PHONEPE" | "PAYTM";
interface Status {
  order_id: string; amount: number; currency_code: string; status: string; terminal: boolean;
  merchant_name: string | null; expires_at: string | null; livemode: boolean; rrn: string | null;
  return_url: string | null;
  headless: { psps: Psp[]; default: Psp | null; chosen: Psp | null; note: string | null; link: { app: string; upi: string } | null } | null;
}

const APP: Record<Psp, { name: string; Logo: typeof PhonePeLogo }> = {
  PHONEPE: { name: "PhonePe", Logo: PhonePeLogo },
  PAYTM: { name: "Paytm", Logo: PaytmLogo },
};

declare global {
  interface Window {
    KatanaShell?: { postMessage: (s: string) => void };
    ReactNativeWebView?: { postMessage: (s: string) => void };
    webkit?: { messageHandlers?: { katana?: { postMessage: (m: unknown) => void } } };
  }
}

/** Tell the merchant's native shell, on whichever bridge it installed. */
function notifyShell(msg: Record<string, unknown>) {
  const s = JSON.stringify(msg);
  try { window.KatanaShell?.postMessage(s); } catch { /* not this bridge */ }
  try { window.webkit?.messageHandlers?.katana?.postMessage(msg); } catch { /* not this bridge */ }
  try { window.ReactNativeWebView?.postMessage(s); } catch { /* not this bridge */ }
  try { if (window.parent !== window) window.parent.postMessage(msg, "*"); } catch { /* not framed */ }
}

function money(n: number, ccy = "INR") {
  try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: ccy, minimumFractionDigits: n % 1 ? 2 : 0 }).format(n); }
  catch { return `${ccy} ${n.toFixed(2)}`; }
}

const FINAL_WORD: Record<string, { title: string; tone: "ok" | "bad" | "late" }> = {
  SUCCESS: { title: "Payment received", tone: "ok" }, SUCCEEDED: { title: "Payment received", tone: "ok" },
  FAILED: { title: "Payment failed", tone: "bad" }, EXPIRED: { title: "Time to pay is over", tone: "late" },
};

export default function HeadlessCheckout({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = use(params);
  const [d, setD] = useState<Status | null>(null);
  const [missing, setMissing] = useState(false);
  const [psp, setPsp] = useState<Psp | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ app: string; upi: string } | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const told = useRef(false);
  const embed = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("embed") === "1";

  const load = useCallback(async (wait = false) => {
    const r = await fetch(`/api/pay-status/${orderId}${wait ? "?wait=1" : ""}`, { cache: "no-store" }).catch(() => null);
    if (!r) return;
    if (r.status === 404) { setMissing(true); return; }
    if (r.ok) setD(await r.json());
  }, [orderId]);

  // First read, then long-poll while the payment is open.
  useEffect(() => {
    let stop = false;
    (async () => {
      await load();
      while (!stop) {
        await load(true);
        await new Promise((res) => setTimeout(res, 800));
      }
    })();
    // Back from the UPI app: ask at once rather than at the next poll.
    const back = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", back);
    return () => { stop = true; document.removeEventListener("visibilitychange", back); };
  }, [load]);

  // Pre-selected app, then the one the payment was started in (it can no longer change).
  useEffect(() => {
    const h = d?.headless;
    if (!h) return;
    if (h.chosen) setPsp(h.chosen);
    else if (!psp) setPsp(h.default ?? h.psps[0] ?? null);
    if (h.link && !opened) setOpened(h.link);
  }, [d, psp, opened]);

  // The customer's time to pay.
  useEffect(() => {
    if (!d?.expires_at || d.terminal) { setLeft(null); return; }
    const t = () => setLeft(Math.max(0, Math.floor((new Date(d.expires_at!).getTime() - Date.now()) / 1000)));
    t(); const i = setInterval(t, 1000);
    return () => clearInterval(i);
  }, [d?.expires_at, d?.terminal]);

  // Final: tell the shell once, then let it close the WebView (embed) or go back to the merchant.
  useEffect(() => {
    if (!d?.terminal || told.current) return;
    told.current = true;
    const result = { type: "katana.checkout.done", id: orderId, order_id: d.order_id, status: d.status };
    notifyShell(result);
    const t = setTimeout(() => {
      if (embed) {
        window.location.href = `katana://checkout/done?${new URLSearchParams({ id: orderId, order_id: d.order_id, status: d.status })}`;
      } else if (d.return_url && /^https?:\/\//i.test(d.return_url)) {
        const u = new URL(d.return_url);
        u.searchParams.set("order_id", d.order_id); u.searchParams.set("status", d.status);
        window.location.href = u.toString();
      }
    }, 2500);
    return () => clearTimeout(t);
  }, [d, embed, orderId]);

  async function pay() {
    if (!psp || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/pay-status/${orderId}/start`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ psp }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error ?? "Couldn't start the payment. Try again.");
      setOpened({ app: b.app, upi: b.upi });
      notifyShell({ type: "katana.checkout.open_app", id: orderId, app: psp, url: b.app, fallback: b.upi });
      // Leaves the WebView: the native shell hands the app link to the OS.
      window.location.href = b.app;
    } catch (e) { setErr((e as Error).message); load(); }
    finally { setBusy(false); }
  }

  async function simulate(outcome: "SUCCESS" | "FAILED") {
    setErr(null);
    const r = await fetch(`/api/pay-status/${orderId}/simulate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outcome }),
    });
    if (!r.ok) setErr((await r.json().catch(() => ({}))).error ?? "Couldn't simulate that.");
    load();
  }

  if (missing) return <Shell><Final title="Payment not found" tone="bad" line="This link is not valid. Go back and start again." /></Shell>;
  if (!d) return <Shell><div className="flex flex-1 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div></Shell>;
  if (!d.headless) return <Shell><Final title="Open the payment page" tone="late" line="This payment is paid on its own page." href={`/pay/${orderId}`} /></Shell>;

  const fin = d.terminal ? FINAL_WORD[d.status] ?? { title: d.status, tone: "bad" as const } : null;
  if (fin) {
    return (
      <Shell test={!d.livemode}>
        <Final title={fin.title} tone={fin.tone} line={`${money(d.amount, d.currency_code)} · Order ${d.order_id}`}
          sub={fin.tone === "ok" && d.rrn ? `Bank reference (UTR) ${d.rrn}` : embed ? "Returning to the app…" : d.return_url ? "Taking you back…" : undefined} />
      </Shell>
    );
  }

  const h = d.headless;
  const locked = !!h.chosen;
  const name = d.merchant_name || "the merchant";
  return (
    <Shell test={!d.livemode}>
      {/* Who is paid */}
      <section className="flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-lg font-semibold text-indigo-700">
          {name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="text-xs text-slate-500">Paying</div>
          <div className="truncate text-base font-semibold text-slate-900">{name}</div>
        </div>
      </section>

      {/* Amount / note to confirm */}
      <section className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
        <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Amount</div>
        <div className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">{money(d.amount, d.currency_code)}</div>
        <div className="mt-2 flex justify-between gap-3 text-sm text-slate-600">
          <span className="truncate">{h.note ?? `Order ${d.order_id}`}</span>
          {left !== null && (
            <span className={`flex shrink-0 items-center gap-1 tabular-nums ${left < 60 ? "text-amber-600" : ""}`}>
              <Clock className="h-3.5 w-3.5" />{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
            </span>
          )}
        </div>
      </section>

      {/* PSP selector */}
      <section className="mt-5">
        <div className="mb-2 text-sm font-medium text-slate-700">Pay with</div>
        <div role="radiogroup" aria-label="Pay with" className="space-y-2">
          {h.psps.map((p) => {
            const { name: app, Logo } = APP[p];
            const on = psp === p;
            const off = locked && h.chosen !== p;
            return (
              <button key={p} type="button" role="radio" aria-checked={on} disabled={off || busy}
                onClick={() => setPsp(p)}
                className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition ${on ? "border-indigo-600 bg-indigo-50/60 ring-2 ring-indigo-600/20" : "border-slate-200 bg-white"} ${off ? "opacity-40" : ""}`}>
                <Logo className="h-8 w-8 shrink-0" />
                <span className="flex-1 font-medium text-slate-900">{app}</span>
                <span className={`flex h-5 w-5 items-center justify-center rounded-full border-2 ${on ? "border-indigo-600" : "border-slate-300"}`}>
                  {on && <span className="h-2.5 w-2.5 rounded-full bg-indigo-600" />}
                </span>
              </button>
            );
          })}
        </div>
        {locked && <p className="mt-2 text-xs text-slate-500">This payment was started in {APP[h.chosen!].name}. Finish it there.</p>}
      </section>

      {err && <p role="alert" className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}

      {/* Pay CTA */}
      <div className="mt-auto pt-6">
        {opened && (
          <p className="mb-3 text-center text-sm text-slate-600">
            Approve the payment in {psp ? APP[psp].name : "your UPI app"}, then come back here.{" "}
            <a className="font-medium text-indigo-700 underline" href={opened.upi}>Open another UPI app</a>
          </p>
        )}
        <button type="button" onClick={pay} disabled={!psp || busy}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-indigo-600 text-base font-semibold text-white shadow-sm transition active:scale-[.99] disabled:opacity-60">
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Lock className="h-4 w-4" />}
          {busy ? "Opening…" : opened ? `Open ${psp ? APP[psp].name : "app"} again` : `Pay ${money(d.amount, d.currency_code)}${psp ? ` with ${APP[psp].name}` : ""}`}
        </button>
        {!d.livemode && (
          <div className="mt-3 rounded-2xl border border-dashed border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
            Test payment: no money moves.
            <div className="mt-2 flex gap-2">
              <button type="button" className="flex-1 rounded-xl bg-emerald-600 py-2 font-medium text-white" onClick={() => simulate("SUCCESS")}>Simulate success</button>
              <button type="button" className="flex-1 rounded-xl bg-white py-2 font-medium text-red-700 ring-1 ring-red-200" onClick={() => simulate("FAILED")}>Simulate failure</button>
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children, test }: { children: React.ReactNode; test?: boolean }) {
  return (
    <main className="flex min-h-[100dvh] justify-center bg-white text-slate-900">
      <div className="flex w-full max-w-md flex-col px-4 pb-6 pt-5">
        <header className="mb-5 flex items-center justify-between text-xs text-slate-500">
          <span className="flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-emerald-600" /> Secure UPI checkout</span>
          {test ? <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">TEST</span> : <span>Katana</span>}
        </header>
        {children}
      </div>
    </main>
  );
}

function Final({ title, tone, line, sub, href }: { title: string; tone: "ok" | "bad" | "late"; line: string; sub?: string; href?: string }) {
  const color = tone === "ok" ? "bg-emerald-100 text-emerald-700" : tone === "bad" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700";
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <div className={`flex h-16 w-16 items-center justify-center rounded-full ${color}`}>
        {tone === "ok" ? <Check className="h-8 w-8" /> : tone === "bad" ? <X className="h-8 w-8" /> : <Clock className="h-8 w-8" />}
      </div>
      <h1 className="mt-4 text-xl font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-slate-600">{line}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
      {href && <a className="mt-4 font-medium text-indigo-700 underline" href={href}>Continue</a>}
    </div>
  );
}
