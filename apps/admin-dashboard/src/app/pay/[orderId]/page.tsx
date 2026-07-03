"use client";

// PUBLIC customer-facing PoolPay payment page. Standalone chrome (no admin
// sidebar/header — /pay is in STANDALONE_PREFIXES and whitelisted in middleware).
// Shows amount, a scannable UPI QR, Paytm / PhonePe / generic-UPI buttons, and a
// live status that polls the public /api/pay-status endpoint until terminal.

import { use, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { QrCode, Copy, CheckCircle2, XCircle, Clock, ShieldCheck, Upload, Loader2, FileCheck2 } from "lucide-react";
import { PaytmLogo, PhonePeLogo, GooglePayLogo } from "@/components/icons/upi-apps";
import { openUpiApp } from "@/lib/upi";

interface PayStatus {
  order_id: string; amount: number; currency_code: string; status: string;
  terminal: boolean; rrn: string | null; mode?: string;
  proof_submitted?: boolean;
  deeplinks: { paytm: string; phonepe: string; upi: string } | null;
  upi_intent: string | null;
  return_url?: string | null;
}

function money(n: number, ccy = "INR") {
  try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: ccy }).format(n); }
  catch { return `${ccy} ${n.toFixed(2)}`; }
}

const STATUS_META: Record<string, { label: string; cls: string; Icon: typeof Clock }> = {
  PENDING: { label: "Awaiting payment", cls: "text-amber-300", Icon: Clock },
  INITIATED: { label: "Awaiting payment", cls: "text-amber-300", Icon: Clock },
  SUCCESS: { label: "Payment received", cls: "text-emerald-400", Icon: CheckCircle2 },
  SUCCEEDED: { label: "Payment received", cls: "text-emerald-400", Icon: CheckCircle2 },
  FAILED: { label: "Payment failed", cls: "text-rose-400", Icon: XCircle },
  EXPIRED: { label: "Payment request expired", cls: "text-rose-400", Icon: XCircle },
};

function PaymentInner({ orderId }: { orderId: string }) {
  const [copied, setCopied] = useState(false);
  // First fetch returns immediately (so the QR + amount render at once); every fetch
  // after that uses wait=1 to long-poll and flip to "received" within ~0.5s of payment.
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
    // The request itself blocks until status changes; this is just the tiny gap before
    // re-arming the next long-poll. Stops entirely once terminal.
    refetchInterval: (query) => (query.state.data?.terminal ? false : 300),
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const d = q.data;
  const status = d?.status ?? "PENDING";
  const meta = STATUS_META[status] ?? STATUS_META.PENDING;
  const StatusIcon = meta.Icon;
  const upi = d?.upi_intent ?? "";

  // After a terminal status, redirect the customer back to the merchant's
  // return_url (if supplied), echoing the result as query params (like a hosted
  // checkout). A short delay lets them see "Payment received" first.
  useEffect(() => {
    if (!d?.terminal || !d.return_url) return;
    const u = new URL(d.return_url);
    u.searchParams.set("order_id", d.order_id);
    u.searchParams.set("status", d.status);
    if (d.rrn) u.searchParams.set("rrn", d.rrn);
    const t = setTimeout(() => { window.location.href = u.toString(); }, 2500);
    return () => clearTimeout(t);
  }, [d?.terminal, d?.return_url, d?.order_id, d?.status, d?.rrn]);

  const copy = () => { navigator.clipboard?.writeText(upi); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  return (
    <main className="force-dark app-canvas flex min-h-screen items-center justify-center px-4 py-10 text-[color:var(--color-text)]">
      <div className="clay-surface w-full max-w-md rounded-3xl p-6 text-[color:var(--color-text)]">
        <div className="mb-5 flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-2)] text-[color:var(--color-brand-fg)] shadow-[0_8px_20px_-8px_var(--color-brand)]">
            <ShieldCheck className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Secure UPI payment</div>
            <div className="text-xs text-[color:var(--color-text-muted)]">Powered by Katana Pay</div>
          </div>
        </div>

        {q.isError ? (
          <div className="rounded-2xl border border-[color:var(--color-border)] p-6 text-center text-sm text-[color:var(--color-text-muted)]">
            This payment link is invalid or has expired.
          </div>
        ) : (
          <>
            <div className="mb-4 text-center">
              <div className="text-xs uppercase tracking-wider text-[color:var(--color-text-muted)]">Amount to pay</div>
              <div className="mt-1 text-4xl font-bold tabular-nums">
                {d ? money(d.amount, d.currency_code) : "…"}
              </div>
              {d && <div className="mt-1 text-xs text-[color:var(--color-text-muted)]">Order {d.order_id}</div>}
            </div>

            <div className={`mb-5 flex items-center justify-center gap-2 text-sm font-medium ${meta.cls}`}>
              <StatusIcon className="h-4 w-4" /> {meta.label}
            </div>

            {!d?.terminal ? (
              d?.proof_submitted ? (
                <div className="rounded-2xl border border-[color:var(--color-border)] p-6 text-center">
                  <FileCheck2 className="mx-auto mb-2 h-10 w-10 text-sky-400" />
                  <div className="text-sm font-medium">Payment proof submitted</div>
                  <div className="mt-1 text-xs text-[color:var(--color-text-muted)]">
                    We&apos;re verifying your payment against the receiver account. This page updates automatically once confirmed.
                  </div>
                </div>
              ) : (
              <>
                {upi && d?.mode !== "INTENT" && (
                  <div className="mb-5 flex flex-col items-center">
                    <div className="rounded-2xl bg-white p-3 shadow-inner">
                      <QRCodeSVG value={upi} size={188} level="M" marginSize={1} />
                    </div>
                    <div className="mt-2 text-xs text-[color:var(--color-text-muted)]">Scan with any UPI app</div>
                  </div>
                )}

                {upi && (
                  <div className="grid grid-cols-1 gap-2">
                    <button type="button" onClick={() => openUpiApp("paytm", upi)} className="flex items-center justify-center gap-2 rounded-xl bg-[color:var(--color-surface)] px-4 py-2.5 text-sm font-medium clay-raised">
                      <PaytmLogo /> Pay with Paytm
                    </button>
                    <button type="button" onClick={() => openUpiApp("phonepe", upi)} className="flex items-center justify-center gap-2 rounded-xl bg-[color:var(--color-surface)] px-4 py-2.5 text-sm font-medium clay-raised">
                      <PhonePeLogo /> Pay with PhonePe
                    </button>
                    <button type="button" onClick={() => openUpiApp("gpay", upi)} className="flex items-center justify-center gap-2 rounded-xl bg-[color:var(--color-surface)] px-4 py-2.5 text-sm font-medium clay-raised">
                      <GooglePayLogo /> Pay with Google Pay
                    </button>
                    <button type="button" onClick={() => openUpiApp("any", upi)} className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-[var(--color-brand)] to-[var(--color-brand-2)] px-4 py-2.5 text-sm font-medium text-[color:var(--color-brand-fg)] clay-raised">
                      <QrCode className="h-4 w-4" /> Open any UPI app
                    </button>
                  </div>
                )}

                {upi && (
                  <button onClick={copy} className="mt-3 flex w-full items-center justify-center gap-2 text-xs text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]">
                    <Copy className="h-3.5 w-3.5" /> {copied ? "Copied UPI string" : "Copy UPI string"}
                  </button>
                )}

                <p className="mt-4 text-center text-xs text-[color:var(--color-text-muted)]">
                  Complete the payment in your UPI app — this page updates automatically.
                </p>

                <ProofUpload orderId={orderId} onSubmitted={() => q.refetch()} />
              </>
              )
            ) : (
              <div className="rounded-2xl border border-[color:var(--color-border)] p-6 text-center">
                <StatusIcon className={`mx-auto mb-2 h-10 w-10 ${meta.cls}`} />
                <div className="text-sm font-medium">{meta.label}</div>
                {d?.rrn && status.startsWith("SUC") && (
                  <div className="mt-1 text-xs text-[color:var(--color-text-muted)]">UPI Ref (RRN): <span className="font-mono">{d.rrn}</span></div>
                )}
                {status === "EXPIRED" || status === "FAILED" ? (
                  <div className="mt-2 text-xs text-[color:var(--color-text-muted)]">Please ask the branch for a fresh payment link.</div>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

// Sender payment-proof upload. After paying by UPI, the sender attaches a screenshot
// (+ optional UTR) so the receiver can verify the credit. Posts multipart to the
// public proof endpoint; the order then moves to "under verification".
function ProofUpload({ orderId, onSubmitted }: { orderId: string; onSubmitted: () => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [utr, setUtr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!file) { setErr("Please choose a screenshot first."); return; }
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (utr.trim()) fd.append("utr", utr.trim());
      const r = await fetch(`/api/pay-status/${orderId}/proof`, { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Upload failed");
      onSubmitted();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="mt-4 border-t border-[color:var(--color-border)] pt-4">
      {!open ? (
        <button onClick={() => setOpen(true)}
          className="flex w-full items-center justify-center gap-2 text-xs font-medium text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]">
          <Upload className="h-3.5 w-3.5" /> Already paid? Submit payment screenshot
        </button>
      ) : (
        <div className="space-y-2">
          <div className="text-xs font-medium">Submit payment proof</div>
          <button onClick={() => inputRef.current?.click()}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[color:var(--color-border)] px-3 py-3 text-xs text-[color:var(--color-text-muted)] hover:bg-[color:var(--color-surface)]">
            <Upload className="h-4 w-4" /> {file ? file.name : "Choose screenshot (PNG / JPG / PDF, max 8MB)"}
          </button>
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="hidden"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setErr(null); }} />
          <input value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="UTR / UPI Ref (optional)"
            className="w-full rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-2 text-xs" />
          {err && <div className="text-xs text-rose-400">{err}</div>}
          <button onClick={submit} disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-[var(--color-brand)] to-[var(--color-brand-2)] px-4 py-2.5 text-sm font-medium text-[color:var(--color-brand-fg)] clay-raised disabled:opacity-60">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck2 className="h-4 w-4" />} {busy ? "Submitting…" : "Submit proof"}
          </button>
        </div>
      )}
    </div>
  );
}

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
