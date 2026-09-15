"use client";

// PUBLIC customer-facing PoolPay payment page. Standalone chrome (no admin
// sidebar/header — /pay is in STANDALONE_PREFIXES and whitelisted in middleware).
// Full-bleed, mobile-first screen whose background gradient takes the tone of the
// order's state: waiting (blue) → success (green) / failed (red) / expired (amber).
// Status polls the public /api/pay-status endpoint.

import { use, useEffect, useRef, useState } from "react";
import { useQuery, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { Copy, Check, ShieldCheck, Upload, Loader2, FileCheck2, ArrowRight, Share2, Smartphone, RefreshCw, X } from "lucide-react";
import { PaytmLogo, PhonePeLogo, GooglePayLogo } from "@/components/icons/upi-apps";
import { openUpiApp } from "@/lib/upi";

interface PayStatus {
  order_id: string; amount: number; currency_code: string; status: string;
  terminal: boolean; rrn: string | null; mode?: string;
  proof_submitted?: boolean;
  deeplinks: { paytm: string; phonepe: string; upi: string } | null;
  upi_intent: string | null;
  return_url?: string | null;
  merchant_name?: string | null;
  payee_vpa?: string | null;
  held?: boolean;
  expires_at?: string | null;
  completed_at?: string | null;
  livemode?: boolean;   // false = a test order: labelled so nobody mistakes it for a real payment
}

type Phase = "loading" | "waiting" | "verifying" | "success" | "failed" | "expired";
type Tone = "waiting" | "verifying" | "success" | "failed" | "expired";
const TONES: Tone[] = ["waiting", "verifying", "success", "failed", "expired"];

const REDIRECT_SECONDS = 5;
// How long one QR is shown before the customer has to ask for it again. Display
// only: the order's own payable window (PENDING_EXPIRY_SECONDS) is unchanged.
const QR_VALID_SECONDS = 30;

function money(n: number, ccy = "INR") {
  try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: ccy, minimumFractionDigits: n % 1 ? 2 : 0 }).format(n); }
  catch { return `${ccy} ${n.toFixed(2)}`; }
}

function when(iso: string) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
    hour12: true, timeZone: "Asia/Kolkata",
  }).format(new Date(iso)).replace(/\b(am|pm)\b/, (m) => m.toUpperCase());
}

function phaseOf(d: PayStatus | undefined): Phase {
  if (!d) return "loading";
  if (d.status === "SUCCESS" || d.status === "SUCCEEDED") return "success";
  if (d.status === "FAILED") return "failed";
  if (d.status === "EXPIRED") return "expired";
  if (d.proof_submitted || d.held) return "verifying";
  return "waiting";
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, value: string) => {
    navigator.clipboard?.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
  };
  return { copied, copy };
}

function PaymentInner({ orderId }: { orderId: string }) {
  // First fetch returns immediately (so the QR + amount render at once); every fetch
  // after that uses wait=1 to long-poll and flip state within ~0.5s of payment.
  const loaded = useRef(false);
  const q = useQuery({
    queryKey: ["pay-status", orderId],
    queryFn: async () => {
      const url = loaded.current ? `/api/pay-status/${orderId}?wait=1` : `/api/pay-status/${orderId}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Not found");
      loaded.current = true;
      return (await r.json()) as PayStatus;
    },
    refetchInterval: (query) => (query.state.data?.terminal ? false : 300),
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const d = q.data;
  const phase = phaseOf(d);
  const merchant = d?.merchant_name?.trim() || null;
  const tone: Tone = phase === "loading" ? "waiting" : phase;

  // Buzz once when the customer is watching the page flip — not when they open an
  // already-finished link.
  const lastPhase = useRef<Phase>("loading");
  useEffect(() => {
    const prev = lastPhase.current;
    lastPhase.current = phase;
    if (prev === "waiting" || prev === "verifying") {
      if (phase === "success") navigator.vibrate?.([40, 60, 40]);
      else if (phase === "failed" || phase === "expired") navigator.vibrate?.(160);
    }
  }, [phase]);

  if (q.isError) {
    return (
      <Screen tone="expired" merchant={null}>
        <div className="kp-rise my-auto text-center">
          <div className="text-lg font-semibold">This payment link isn&apos;t valid</div>
          <p className="kp-dim mx-auto mt-2 max-w-[30ch] text-sm">
            Check the link, or go back to the merchant and start the payment again.
          </p>
        </div>
      </Screen>
    );
  }

  return (
    <Screen tone={tone} merchant={merchant} test={d?.livemode === false}>
      <div aria-live="polite" className="flex flex-1 flex-col">
        {phase === "loading" && <LoadingBody />}
        {phase === "waiting" && d && <WaitingBody key="waiting" d={d} merchant={merchant} orderId={orderId} onProof={() => q.refetch()} />}
        {phase === "verifying" && d && <VerifyingBody key="verifying" d={d} />}
        {phase === "success" && d && <SuccessBody key="success" d={d} merchant={merchant} />}
        {(phase === "failed" || phase === "expired") && d && <FailedBody key={phase} d={d} phase={phase} merchant={merchant} />}
      </div>
    </Screen>
  );
}

/* ------------------------------------------------------------------ chrome */

function Screen({ tone, merchant, test = false, children }: { tone: Tone; merchant: string | null; test?: boolean; children: React.ReactNode }) {
  return (
    <main className="kp-root force-dark relative min-h-[100dvh] overflow-hidden">
      <style>{KP_CSS}</style>
      <div className="kp-bg" aria-hidden>
        {TONES.map((t) => <div key={t} className={`kp-bg-layer kp-bg-${t}`} data-on={t === tone} />)}
      </div>
      <div className="relative mx-auto flex min-h-[100dvh] w-full max-w-[420px] flex-col px-5 pb-6 pt-5">
        <header className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span aria-hidden className="kp-avatar">{merchant ? merchant.charAt(0).toUpperCase() : "K"}</span>
            <span className="truncate text-sm font-semibold">{merchant ?? "Katana Pay"}</span>
          </div>
          {test ? (
            // A test order pays a sandbox UPI ID: say so plainly, in place of the security claim.
            <span className="flex shrink-0 items-center rounded-full px-2.5 py-1 text-[11px] font-semibold"
              style={{ background: "#fb923c", color: "#1c0a00" }}>
              Test payment
            </span>
          ) : (
            <span className="kp-dim flex shrink-0 items-center gap-1 text-[11px]">
              <ShieldCheck className="h-3.5 w-3.5" /> Secured UPI
            </span>
          )}
        </header>
        {children}
        <footer className="kp-faint mt-5 text-center text-[11px]">Powered by Katana Pay</footer>
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ states */

function LoadingBody() {
  return (
    <div className="mt-10 flex flex-col items-center gap-4">
      <div className="kp-shimmer h-4 w-24 rounded-full" />
      <div className="kp-shimmer h-11 w-44 rounded-xl" />
      <div className="kp-shimmer mt-4 h-[240px] w-full rounded-3xl" />
    </div>
  );
}

function WaitingBody({ d, merchant, orderId, onProof }: { d: PayStatus; merchant: string | null; orderId: string; onProof: () => void }) {
  const upi = d.upi_intent ?? "";
  const { copied, copy } = useCopy();
  const showQr = upi && d.mode !== "INTENT";

  // The QR (and the other ways to start a payment) is shown for QR_VALID_SECONDS at a
  // time. The order itself stays payable for its full window and this screen keeps
  // listening, so a customer who scanned just before the QR hid still gets confirmed.
  const [qrRound, setQrRound] = useState(0);
  const [qrLeft, setQrLeft] = useState(QR_VALID_SECONDS);
  useEffect(() => {
    const started = Date.now();
    setQrLeft(QR_VALID_SECONDS);
    const t = setInterval(() => {
      const left = Math.max(0, QR_VALID_SECONDS - Math.floor((Date.now() - started) / 1000));
      setQrLeft(left);
      if (left === 0) clearInterval(t);
    }, 250);
    return () => clearInterval(t);
  }, [qrRound]);
  const qrLive = qrLeft > 0;
  const qrLow = qrLive && qrLeft <= 10;

  return (
    <div className="flex flex-1 flex-col">
      <div className="kp-rise mt-8 text-center">
        <div className="kp-dim text-[13px]">Amount to pay{merchant ? ` to ${merchant}` : ""}</div>
        <div className="kp-amount mt-1">{money(d.amount, d.currency_code)}</div>
        <div className="mt-3 inline-flex items-center gap-2 rounded-full kp-glass px-3 py-1.5 text-xs">
          <span className="kp-live" aria-hidden />
          <span className="font-medium">Waiting for payment</span>
          {upi && (
            <span className={`tabular-nums ${qrLive ? (qrLow ? "kp-warn" : "kp-dim") : "kp-warn"}`}>
              · {qrLive ? `QR 0:${String(qrLeft).padStart(2, "0")}` : "QR expired"}
            </span>
          )}
        </div>
      </div>

      {showQr && (
        <div className="kp-rise kp-glass mt-6 flex flex-col items-center rounded-3xl px-5 pb-4 pt-5" style={{ animationDelay: "80ms" }}>
          <div className="relative rounded-2xl bg-white p-3 shadow-[0_20px_50px_-20px_rgba(0,0,0,.7)]">
            <div className={qrLive ? "" : "kp-qr-dead"} aria-hidden={!qrLive}>
              <QRCodeSVG value={upi} size={176} level="M" marginSize={1} />
            </div>
            {qrLive ? (
              <span className="kp-scan" aria-hidden />
            ) : (
              <div className="kp-rise absolute inset-0 flex flex-col items-center justify-center gap-2.5 text-center">
                <div className="text-[15px] font-semibold text-[#0b1210]">QR expired</div>
                <button type="button" onClick={() => setQrRound((r) => r + 1)} className="kp-qr-again">
                  <RefreshCw className="h-4 w-4" /> Show QR again
                </button>
              </div>
            )}
          </div>
          {qrLive ? (
            <>
              <div className="kp-qrbar mt-4 w-[200px]" data-low={qrLow} aria-hidden>
                <span style={{ transform: `scaleX(${qrLeft / QR_VALID_SECONDS})` }} />
              </div>
              <div className="kp-dim mt-2 text-xs">Scan with any UPI app</div>
            </>
          ) : (
            <p className="kp-dim kp-rise mt-3.5 max-w-[30ch] text-center text-xs">
              Already scanned? Finish in your UPI app. This screen still updates when the payment lands.
            </p>
          )}
        </div>
      )}

      {!showQr && upi && !qrLive && (
        <div className="kp-rise kp-glass mt-6 flex flex-col items-center rounded-3xl px-5 py-5 text-center">
          <div className="text-[15px] font-semibold">Payment options expired</div>
          <button type="button" onClick={() => setQrRound((r) => r + 1)} className="kp-pill kp-pill-solid mt-3 !h-10 !w-auto px-5 !text-sm">
            <RefreshCw className="h-4 w-4" /> Show options again
          </button>
          <p className="kp-dim mt-3 max-w-[30ch] text-xs">
            Already approved in your UPI app? This screen still updates when the payment lands.
          </p>
        </div>
      )}

      {upi && qrLive && (
        <div className="kp-rise mt-4 grid grid-cols-3 gap-2.5" style={{ animationDelay: "140ms" }}>
          <AppTile label="Paytm" onClick={() => openUpiApp("paytm", upi)}><PaytmLogo /></AppTile>
          <AppTile label="PhonePe" onClick={() => openUpiApp("phonepe", upi)}><PhonePeLogo /></AppTile>
          <AppTile label="GPay" onClick={() => openUpiApp("gpay", upi)}><GooglePayLogo /></AppTile>
        </div>
      )}

      {d.payee_vpa && qrLive && (
        <button type="button" onClick={() => copy("vpa", d.payee_vpa!)}
          className="kp-rise kp-glass kp-press mt-2.5 flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left"
          style={{ animationDelay: "180ms" }}>
          <span className="min-w-0">
            <span className="kp-dim block text-[11px]">Or pay to UPI ID</span>
            <span className="block truncate font-mono text-[13px]">{d.payee_vpa}</span>
          </span>
          <span className="kp-dim flex shrink-0 items-center gap-1 text-xs">
            {copied === "vpa" ? <><Check className="h-3.5 w-3.5" /> Copied</> : <><Copy className="h-3.5 w-3.5" /> Copy</>}
          </span>
        </button>
      )}

      {/* A test order is settled with the simulator, not a screenshot. */}
      {d.livemode === false
        ? <TestSimulate orderId={orderId} onDone={onProof} />
        : <ProofUpload orderId={orderId} onSubmitted={onProof} />}

      <div className="mt-auto pt-6">
        {upi && qrLive && (
          <button type="button" onClick={() => openUpiApp("any", upi)} className="kp-pill kp-pill-solid">
            <Smartphone className="h-4 w-4" /> Pay with any UPI app
          </button>
        )}
        <p className="kp-faint mt-2.5 text-center text-[11px]">Order {d.order_id} · this screen updates on its own</p>
      </div>
    </div>
  );
}

function AppTile({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className="kp-glass kp-press flex flex-col items-center justify-center gap-1.5 rounded-2xl px-2 py-3 text-[11px] font-medium">
      {children}
      <span className="kp-dim">{label}</span>
    </button>
  );
}

function VerifyingBody({ d }: { d: PayStatus }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <div className="kp-coin kp-coin-verifying" style={{ ["--kp-c" as string]: "#38bdf8" }}>
        <span className="kp-coin-spin" aria-hidden />
        <FileCheck2 className="relative h-9 w-9 text-white" />
      </div>
      <h1 className="kp-rise mt-6 text-xl font-semibold">Verifying your payment</h1>
      <div className="kp-amount kp-rise mt-2">{money(d.amount, d.currency_code)}</div>
      <p className="kp-dim kp-rise mt-3 max-w-[32ch] text-sm">
        {d.proof_submitted
          ? "We got your screenshot and are matching it with the credit. This screen updates once it's confirmed."
          : "Payments of this size get a quick manual check. This screen updates once it's confirmed."}
      </p>
      <p className="kp-faint mt-3 text-xs">Please don&apos;t pay again.</p>
    </div>
  );
}

function SuccessBody({ d, merchant }: { d: PayStatus; merchant: string | null }) {
  const { copied, copy } = useCopy();
  const target = safeReturnUrl(d);
  const [left, setLeft] = useState(REDIRECT_SECONDS);

  useEffect(() => {
    if (!target) return;
    if (left <= 0) { window.location.href = target; return; }
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left, target]);

  const share = async () => {
    const text = [
      `Payment successful: ${money(d.amount, d.currency_code)}${merchant ? ` to ${merchant}` : ""}`,
      d.rrn ? `UPI ref: ${d.rrn}` : null,
      `Order: ${d.order_id}`,
      d.completed_at ? when(d.completed_at) + " IST" : null,
    ].filter(Boolean).join("\n");
    try {
      if (navigator.share) { await navigator.share({ title: "Payment receipt", text }); return; }
    } catch { return; /* customer closed the share sheet */ }
    copy("share", text);
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="mt-10 flex flex-col items-center text-center">
        <ResultCoin kind="success" />
        <div className="kp-rise mt-5 text-[15px] font-medium" style={{ animationDelay: "700ms" }}>Payment successful</div>
        <div className="kp-rise kp-amount mt-1" style={{ animationDelay: "760ms" }}>{money(d.amount, d.currency_code)}</div>
        <div className="kp-rise kp-dim mt-1.5 text-xs" style={{ animationDelay: "820ms" }}>
          {merchant ? `Paid to ${merchant}` : "Paid"}{d.completed_at ? ` · ${when(d.completed_at)}` : ""}
        </div>
      </div>

      <div className="kp-rise mt-7 flex items-start justify-center gap-8" style={{ animationDelay: "900ms" }}>
        <RoundAction label={copied === "share" ? "Copied" : "Share receipt"} onClick={share}>
          {copied === "share" ? <Check className="h-5 w-5" /> : <Share2 className="h-5 w-5" />}
        </RoundAction>
        {d.rrn && (
          <RoundAction label={copied === "rrn" ? "Copied" : "Copy UPI ref"} onClick={() => copy("rrn", d.rrn!)}>
            {copied === "rrn" ? <Check className="h-5 w-5" /> : <Copy className="h-5 w-5" />}
          </RoundAction>
        )}
      </div>

      <dl className="kp-rise kp-glass kp-receipt mt-7 rounded-3xl px-5 py-1 text-[13.5px]" style={{ animationDelay: "980ms" }}>
        {merchant && <Row label="Paid to" value={merchant} />}
        {d.payee_vpa && <Row label="UPI ID" value={d.payee_vpa} mono />}
        {d.rrn && <Row label="UPI reference" value={d.rrn} mono />}
        <Row label="Order ID" value={d.order_id} mono />
        {d.completed_at && <Row label="Date" value={when(d.completed_at)} />}
      </dl>

      <div className="kp-rise mt-auto pt-7" style={{ animationDelay: "1060ms" }}>
        {target ? (
          <a href={target} className="kp-pill kp-pill-glass relative overflow-hidden">
            <span className="kp-pill-fill" style={{ animationDuration: `${REDIRECT_SECONDS}s` }} aria-hidden />
            <span className="relative flex items-center gap-2">
              Back to {merchant ?? "merchant"} <span className="kp-dim tabular-nums">({Math.max(left, 0)}s)</span>
              <ArrowRight className="h-4 w-4" />
            </span>
          </a>
        ) : (
          <p className="kp-dim text-center text-xs">Keep the UPI reference for your records. You can close this page.</p>
        )}
      </div>
    </div>
  );
}

function FailedBody({ d, phase, merchant }: { d: PayStatus; phase: "failed" | "expired"; merchant: string | null }) {
  const target = safeReturnUrl(d);
  const who = merchant ?? "the merchant";
  const expired = phase === "expired";
  return (
    <div className="flex flex-1 flex-col">
      <div className="mt-10 flex flex-col items-center text-center">
        <ResultCoin kind={phase} />
        <div className="kp-rise mt-5 text-[15px] font-medium" style={{ animationDelay: "700ms" }}>
          {expired ? "Payment request expired" : "Payment failed"}
        </div>
        <div className="kp-rise kp-amount kp-amount-muted mt-1" style={{ animationDelay: "760ms" }}>{money(d.amount, d.currency_code)}</div>
        <div className="kp-rise kp-dim mt-1.5 text-xs" style={{ animationDelay: "820ms" }}>
          {merchant ? `to ${merchant} · ` : ""}Order {d.order_id}
        </div>
      </div>

      <div className="kp-rise kp-glass mt-8 rounded-3xl px-5 py-4 text-[13.5px] leading-relaxed" style={{ animationDelay: "900ms" }}>
        <p className="font-medium">
          {expired ? "This link is no longer active." : "The payment didn't go through."}
        </p>
        <p className="kp-dim mt-1">
          {expired ? "Start a new payment from the merchant's page." : "Try again from the merchant's page."}
        </p>
        <div className="kp-rule my-3.5" />
        <p className="font-medium">Money left your account?</p>
        <p className="kp-dim mt-1">
          {expired
            ? `Don't pay again. A late payment is still matched to this order. Contact ${who} with the order ID and the UPI reference from your bank app.`
            : `Contact ${who} with the order ID and the UPI reference from your bank app. Failed UPI debits are usually reversed by your bank.`}
        </p>
      </div>

      <div className="kp-rise mt-auto pt-7" style={{ animationDelay: "980ms" }}>
        {target && (
          <a href={target} className="kp-pill kp-pill-glass">
            Back to {who} <ArrowRight className="h-4 w-4" />
          </a>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ parts */

function RoundAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="group flex w-20 flex-col items-center gap-2 text-center">
      <span className="kp-glass kp-press flex h-14 w-14 items-center justify-center rounded-full">{children}</span>
      <span className="kp-dim text-[11.5px] leading-tight group-hover:text-white">{label}</span>
    </button>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3">
      <dt className="kp-dim shrink-0">{label}</dt>
      <dd className={`min-w-0 break-all text-right ${mono ? "font-mono text-[12.5px]" : "font-medium"}`}>{value}</dd>
    </div>
  );
}

// Glossy status coin: pops in, a light sheen sweeps across, then the glyph draws.
// Success adds a bloom and sparks; failure shakes.
function ResultCoin({ kind }: { kind: "success" | "failed" | "expired" }) {
  const c = kind === "success" ? "#34d399" : kind === "failed" ? "#f87171" : "#fbbf24";
  return (
    <div className={`kp-coin kp-coin-${kind}`} style={{ ["--kp-c" as string]: c }}
      role="img" aria-label={kind === "success" ? "Payment successful" : kind === "failed" ? "Payment failed" : "Payment expired"}>
      <span className="kp-bloom" aria-hidden />
      {kind === "success" && (
        <span className="kp-sparks" aria-hidden>
          {Array.from({ length: 12 }).map((_, i) => <i key={i} style={{ ["--a" as string]: `${i * 30}deg` }} />)}
        </span>
      )}
      <span className="kp-coin-face" aria-hidden><span className="kp-sheen" /></span>
      <svg viewBox="0 0 96 96" className="relative h-[46%] w-[46%]" aria-hidden>
        {kind === "success" && <path d="M22 50 L40 67 L74 31" className="kp-glyph" pathLength={1} />}
        {kind === "failed" && (<><path d="M28 28 L68 68" className="kp-glyph" pathLength={1} /><path d="M68 28 L28 68" className="kp-glyph kp-glyph-2" pathLength={1} /></>)}
        {kind === "expired" && (<><path d="M48 20 L48 50" className="kp-glyph" pathLength={1} /><path d="M48 50 L68 62" className="kp-glyph kp-glyph-2" pathLength={1} /></>)}
      </svg>
    </div>
  );
}

function safeReturnUrl(d: PayStatus): string | null {
  if (!d.terminal || !d.return_url) return null;
  let u: URL;
  try { u = new URL(d.return_url); } catch { return null; }
  // Only ever redirect to an http(s) target (audit M8) — belt-and-braces with the
  // scheme check enforced at order creation.
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.searchParams.set("order_id", d.order_id);
  u.searchParams.set("status", d.status);
  if (d.rrn) u.searchParams.set("rrn", d.rrn);
  return u.toString();
}

// Sender payment-proof upload. After paying by UPI, the sender attaches a screenshot
// (+ optional UTR) so the receiver can verify the credit. Posts multipart to the
// public proof endpoint; the order then moves to "under verification".
// Test orders only: decide the outcome without paying. The order goes through the same
// confirmation as a real payment, so the merchant's server receives its usual status callback.
function TestSimulate({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const [busy, setBusy] = useState<"SUCCESS" | "FAILED" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (outcome: "SUCCESS" | "FAILED") => {
    setBusy(outcome); setErr(null);
    try {
      const r = await fetch(`/api/pay-status/${orderId}/simulate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outcome }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Couldn't simulate that. Try again.");
      onDone();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <div className="kp-rise mt-4 rounded-3xl p-4" style={{ border: "1px dashed rgba(251,146,60,.55)", background: "rgba(251,146,60,.08)" }}>
      <div className="text-sm font-semibold" style={{ color: "#fdba74" }}>Test payment: no money moves</div>
      <p className="kp-dim mt-1 text-xs">Choose what happens to this order. Your server receives the same callback a real payment sends.</p>
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <button type="button" disabled={!!busy} onClick={() => run("SUCCESS")} className="kp-pill kp-pill-solid !h-11 !text-sm disabled:opacity-60">
          {busy === "SUCCESS" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Simulate success
        </button>
        <button type="button" disabled={!!busy} onClick={() => run("FAILED")} className="kp-pill kp-pill-glass !h-11 !text-sm disabled:opacity-60">
          {busy === "FAILED" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Simulate failure
        </button>
      </div>
      {err && <div className="mt-2 text-xs text-red-300">{err}</div>}
    </div>
  );
}

function ProofUpload({ orderId, onSubmitted }: { orderId: string; onSubmitted: () => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [utr, setUtr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!file) { setErr("Choose a screenshot of the payment first."); return; }
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (utr.trim()) fd.append("utr", utr.trim());
      const r = await fetch(`/api/pay-status/${orderId}/proof`, { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Upload failed. Try again.");
      onSubmitted();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="kp-dim mt-4 flex w-full items-center justify-center gap-2 text-xs font-medium hover:text-white">
        <Upload className="h-3.5 w-3.5" /> Already paid? Send us the screenshot
      </button>
    );
  }
  return (
    <div className="kp-rise kp-glass mt-4 space-y-2.5 rounded-3xl p-4">
      <div className="text-sm font-medium">Send payment screenshot</div>
      <button onClick={() => inputRef.current?.click()}
        className="kp-dim flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-white/25 px-3 py-3 text-xs hover:text-white">
        <Upload className="h-4 w-4" /> {file ? file.name : "Choose screenshot (PNG, JPG or PDF, up to 8 MB)"}
      </button>
      <input id="kp-proof-file" ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="hidden"
        onChange={(e) => { setFile(e.target.files?.[0] ?? null); setErr(null); }} />
      <input id="kp-proof-utr" value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="UPI reference / UTR (optional)"
        className="kp-input w-full rounded-2xl px-3.5 py-2.5 text-xs" />
      {err && <div className="text-xs text-red-300">{err}</div>}
      <button onClick={submit} disabled={busy} className="kp-pill kp-pill-solid !h-11 disabled:opacity-60">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck2 className="h-4 w-4" />} {busy ? "Sending…" : "Send screenshot"}
      </button>
    </div>
  );
}

// Page-scoped visual system. The screen commits to one dark world whose gradient
// takes the tone of the payment state; layers cross-fade when the state changes.
// All motion is decoration over a readable resting state and switches off under
// prefers-reduced-motion.
const KP_CSS = `
.kp-root{background:#050807;color:#f4f7f6;font-feature-settings:"tnum" 0}
.kp-dim{color:rgba(236,244,241,.62)}
.kp-faint{color:rgba(236,244,241,.4)}
.kp-warn{color:#fcd34d}
.kp-rule{height:1px;background:rgba(255,255,255,.1)}

.kp-bg{position:fixed;inset:0;pointer-events:none}
.kp-bg-layer{position:absolute;inset:-10%;opacity:0;transform:scale(1.08);transition:opacity 1s ease,transform 1.4s cubic-bezier(.2,.8,.2,1)}
.kp-bg-layer[data-on="true"]{opacity:1;transform:scale(1)}
.kp-bg-layer::after{content:"";position:absolute;inset:0;background:radial-gradient(60% 40% at 50% 108%,var(--glow),transparent 70%)}
.kp-bg-waiting  {--glow:rgba(59,130,246,.22);background:radial-gradient(110% 62% at 50% 4%,#2f5fc4 0%,#12295a 36%,#070b16 72%,#05070c 100%)}
.kp-bg-verifying{--glow:rgba(56,189,248,.2); background:radial-gradient(110% 62% at 50% 4%,#2a8fb5 0%,#0d3346 36%,#06101a 72%,#05080b 100%)}
.kp-bg-success  {--glow:rgba(52,211,153,.24);background:radial-gradient(110% 62% at 50% 6%,#4fb88e 0%,#1d5a43 30%,#0a2419 58%,#050a08 100%)}
.kp-bg-failed   {--glow:rgba(248,113,113,.18);background:radial-gradient(110% 62% at 50% 6%,#b4494b 0%,#5a1d22 30%,#240b0e 58%,#090506 100%)}
.kp-bg-expired  {--glow:rgba(251,191,36,.16);background:radial-gradient(110% 62% at 50% 6%,#b98331 0%,#5a3d17 30%,#231708 58%,#090705 100%)}

.kp-glass{background:linear-gradient(180deg,rgba(255,255,255,.09),rgba(255,255,255,.04));border:1px solid rgba(255,255,255,.11);-webkit-backdrop-filter:blur(18px) saturate(140%);backdrop-filter:blur(18px) saturate(140%);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 20px 40px -30px rgba(0,0,0,.8)}
.kp-press{transition:transform .15s ease,background-color .15s ease,border-color .15s ease}
.kp-press:hover{border-color:rgba(255,255,255,.22)}
.kp-press:active{transform:scale(.97)}
.kp-input{background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.12);color:inherit}
.kp-input::placeholder{color:rgba(236,244,241,.4)}

.kp-avatar{display:grid;place-items:center;width:32px;height:32px;border-radius:11px;font-size:14px;font-weight:600;background:linear-gradient(145deg,rgba(255,255,255,.28),rgba(255,255,255,.08));border:1px solid rgba(255,255,255,.18)}
.kp-amount{font-size:46px;line-height:1.05;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kp-amount-muted{color:rgba(236,244,241,.7)}

.kp-pill{display:flex;width:100%;height:54px;align-items:center;justify-content:center;gap:8px;border-radius:999px;font-size:15px;font-weight:600;transition:transform .15s ease,filter .15s ease}
.kp-pill:active{transform:scale(.98)}
.kp-pill-solid{background:#f4f7f6;color:#0b1210;box-shadow:0 14px 30px -14px rgba(0,0,0,.7)}
.kp-pill-solid:hover{filter:brightness(.95)}
.kp-pill-glass{background:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,.07));border:1px solid rgba(255,255,255,.18);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);box-shadow:inset 0 1px 0 rgba(255,255,255,.14)}
.kp-pill-fill{position:absolute;inset:0;background:rgba(255,255,255,.1);transform-origin:left;animation:kp-fill linear forwards}
@keyframes kp-fill{from{transform:scaleX(0)}to{transform:scaleX(1)}}

.kp-receipt>div+div{border-top:1px solid rgba(255,255,255,.08)}

.kp-rise{animation:kp-rise .5s cubic-bezier(.2,.8,.2,1) both}
@keyframes kp-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.kp-shimmer{background:linear-gradient(90deg,rgba(255,255,255,.05),rgba(255,255,255,.12),rgba(255,255,255,.05));background-size:200% 100%;animation:kp-shimmer 1.4s linear infinite}
@keyframes kp-shimmer{to{background-position:-200% 0}}

.kp-live{position:relative;width:7px;height:7px;border-radius:50%;background:#4ade80}
.kp-live::after{content:"";position:absolute;inset:0;border-radius:50%;background:#4ade80;animation:kp-ping 1.6s cubic-bezier(0,0,.2,1) infinite}
@keyframes kp-ping{75%,100%{transform:scale(2.8);opacity:0}}
.kp-scan{position:absolute;left:12px;right:12px;top:12px;height:2px;border-radius:2px;background:linear-gradient(90deg,transparent,#3b82f6,transparent);box-shadow:0 0 14px #3b82f6;opacity:.75;animation:kp-scan 2.6s ease-in-out infinite}
@keyframes kp-scan{0%,100%{transform:translateY(0)}50%{transform:translateY(174px)}}
.kp-qrbar{height:3px;border-radius:3px;background:rgba(255,255,255,.14);overflow:hidden}
.kp-qrbar>span{display:block;height:100%;border-radius:3px;background:#f4f7f6;transform-origin:left;transition:transform .25s linear,background-color .3s ease}
.kp-qrbar[data-low="true"]>span{background:#fcd34d}
.kp-qr-dead{filter:blur(7px);opacity:.18;transition:filter .5s ease,opacity .5s ease}
.kp-qr-again{display:inline-flex;align-items:center;gap:7px;height:38px;padding:0 16px;border-radius:999px;background:#0b1210;color:#f4f7f6;font-size:13px;font-weight:600;box-shadow:0 10px 22px -12px rgba(0,0,0,.6);transition:transform .15s ease}
.kp-qr-again:active{transform:scale(.97)}

/* Coin */
.kp-coin{position:relative;display:grid;place-items:center;width:92px;height:92px;animation:kp-coin-in .6s cubic-bezier(.3,1.6,.5,1) both}
@keyframes kp-coin-in{0%{opacity:0;transform:scale(.3) rotate(-25deg)}100%{opacity:1;transform:none}}
.kp-coin-face{position:absolute;inset:0;border-radius:50%;overflow:hidden;
  background:radial-gradient(circle at 34% 28%,rgba(255,255,255,.75) 0%,color-mix(in oklab,var(--kp-c) 80%,white) 16%,var(--kp-c) 42%,color-mix(in oklab,var(--kp-c) 45%,black) 100%);
  box-shadow:inset 0 -6px 12px rgba(0,0,0,.35),inset 0 4px 8px rgba(255,255,255,.35),0 0 0 5px color-mix(in oklab,var(--kp-c) 22%,transparent),0 18px 36px -12px color-mix(in oklab,var(--kp-c) 70%,black)}
.kp-sheen{position:absolute;top:-20%;bottom:-20%;width:40%;left:-60%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.55),transparent);transform:skewX(-18deg);animation:kp-sheen 1s ease-in-out .45s both}
@keyframes kp-sheen{to{left:130%}}
.kp-glyph{fill:none;stroke:#fff;stroke-width:11;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1;filter:drop-shadow(0 2px 2px rgba(0,0,0,.25));animation:kp-draw .38s cubic-bezier(.65,0,.35,1) .5s forwards}
.kp-glyph-2{animation-delay:.72s}
@keyframes kp-draw{to{stroke-dashoffset:0}}
.kp-bloom{position:absolute;inset:-60%;border-radius:50%;background:radial-gradient(circle,color-mix(in oklab,var(--kp-c) 45%,transparent) 0%,transparent 62%);animation:kp-bloom 1.8s ease-out .35s both}
@keyframes kp-bloom{0%{opacity:0;transform:scale(.4)}30%{opacity:1}100%{opacity:.45;transform:scale(1.15)}}
.kp-sparks{position:absolute;inset:0}
.kp-sparks i{position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px;border-radius:50%;background:#bbf7d0;opacity:0;animation:kp-spark .9s cubic-bezier(.2,.8,.2,1) .62s forwards}
.kp-sparks i:nth-child(3n){width:4px;height:4px;margin:-2px;background:#fff}
@keyframes kp-spark{0%{opacity:1;transform:rotate(var(--a)) translateY(-40px) scale(1)}100%{opacity:0;transform:rotate(var(--a)) translateY(-96px) scale(.3)}}
.kp-coin-failed{animation:kp-coin-in .6s cubic-bezier(.3,1.6,.5,1) both,kp-shake .5s cubic-bezier(.36,.07,.19,.97) 1s}
@keyframes kp-shake{10%,90%{transform:translateX(-1px)}20%,80%{transform:translateX(3px)}30%,50%,70%{transform:translateX(-6px)}40%,60%{transform:translateX(6px)}}
.kp-coin-verifying{border-radius:50%;background:radial-gradient(circle at 34% 28%,rgba(255,255,255,.5),var(--kp-c) 45%,color-mix(in oklab,var(--kp-c) 40%,black));box-shadow:0 0 0 5px color-mix(in oklab,var(--kp-c) 22%,transparent)}
.kp-coin-spin{position:absolute;inset:-10px;border-radius:50%;border:3px solid transparent;border-top-color:rgba(255,255,255,.8);animation:kp-spin 1.1s linear infinite}
@keyframes kp-spin{to{transform:rotate(360deg)}}

@media (prefers-reduced-motion: reduce){
  .kp-bg-layer{transition:none;transform:none}
  .kp-rise,.kp-coin,.kp-coin-failed{animation:none}
  .kp-glyph{animation:none;stroke-dashoffset:0}
  .kp-bloom{animation:none;opacity:.45}
  .kp-sheen,.kp-sparks,.kp-scan,.kp-live::after{display:none}
  .kp-shimmer,.kp-coin-spin,.kp-pill-fill{animation:none}
  .kp-qrbar>span,.kp-qr-dead{transition:none}
}
`;

export default function PublicPayPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = use(params);
  // Self-contained QueryClient — this public page renders outside the admin
  // Providers tree (it's a standalone shell).
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }));
  return (
    <QueryClientProvider client={qc}>
      <PaymentInner orderId={orderId} />
    </QueryClientProvider>
  );
}
