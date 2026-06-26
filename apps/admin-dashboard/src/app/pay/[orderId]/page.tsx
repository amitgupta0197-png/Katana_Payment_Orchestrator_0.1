"use client";

// PUBLIC customer-facing PoolPay payment page. Standalone chrome (no admin
// sidebar/header — /pay is in STANDALONE_PREFIXES and whitelisted in middleware).
// Shows amount, a scannable UPI QR, Paytm / PhonePe / generic-UPI buttons, and a
// live status that polls the public /api/pay-status endpoint until terminal.

import { use, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { Smartphone, QrCode, Copy, CheckCircle2, XCircle, Clock, ShieldCheck } from "lucide-react";

interface PayStatus {
  order_id: string; amount: number; currency_code: string; status: string;
  terminal: boolean; rrn: string | null;
  deeplinks: { paytm: string; phonepe: string; upi: string } | null;
  upi_intent: string | null;
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
  const q = useQuery({
    queryKey: ["pay-status", orderId],
    queryFn: async () => {
      const r = await fetch(`/api/pay-status/${orderId}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Not found");
      return (await r.json()) as PayStatus;
    },
    refetchInterval: (query) => (query.state.data?.terminal ? false : 3000),
    retry: 1,
  });

  const d = q.data;
  const status = d?.status ?? "PENDING";
  const meta = STATUS_META[status] ?? STATUS_META.PENDING;
  const StatusIcon = meta.Icon;
  const dl = d?.deeplinks;
  const upi = d?.upi_intent ?? "";

  const copy = () => { navigator.clipboard?.writeText(upi); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  return (
    <main className="app-canvas flex min-h-screen items-center justify-center px-4 py-10">
      <div className="clay-surface w-full max-w-md rounded-3xl p-6 text-[color:var(--color-text)]">
        <div className="mb-5 flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-2)] text-[color:var(--color-brand-fg)] shadow-[0_8px_20px_-8px_var(--color-brand)]">
            <ShieldCheck className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Secure UPI payment</div>
            <div className="text-xs text-[color:var(--color-text-muted)]">Powered by PoolPay · Katana</div>
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
              <>
                {upi && (
                  <div className="mb-5 flex flex-col items-center">
                    <div className="rounded-2xl bg-white p-3 shadow-inner">
                      <QRCodeSVG value={upi} size={188} level="M" marginSize={1} />
                    </div>
                    <div className="mt-2 text-xs text-[color:var(--color-text-muted)]">Scan with any UPI app</div>
                  </div>
                )}

                {dl && (
                  <div className="grid grid-cols-1 gap-2">
                    <a href={dl.paytm} className="flex items-center justify-center gap-2 rounded-xl bg-[color:var(--color-surface)] px-4 py-2.5 text-sm font-medium clay-raised">
                      <Smartphone className="h-4 w-4" /> Pay with Paytm
                    </a>
                    <a href={dl.phonepe} className="flex items-center justify-center gap-2 rounded-xl bg-[color:var(--color-surface)] px-4 py-2.5 text-sm font-medium clay-raised">
                      <Smartphone className="h-4 w-4" /> Pay with PhonePe
                    </a>
                    <a href={dl.upi} className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-[var(--color-brand)] to-[var(--color-brand-2)] px-4 py-2.5 text-sm font-medium text-[color:var(--color-brand-fg)] clay-raised">
                      <QrCode className="h-4 w-4" /> Open any UPI app
                    </a>
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
              </>
            ) : (
              <div className="rounded-2xl border border-[color:var(--color-border)] p-6 text-center">
                <StatusIcon className={`mx-auto mb-2 h-10 w-10 ${meta.cls}`} />
                <div className="text-sm font-medium">{meta.label}</div>
                {d?.rrn && status.startsWith("SUC") && (
                  <div className="mt-1 text-xs text-[color:var(--color-text-muted)]">UPI Ref (RRN): <span className="font-mono">{d.rrn}</span></div>
                )}
                {status === "EXPIRED" || status === "FAILED" ? (
                  <div className="mt-2 text-xs text-[color:var(--color-text-muted)]">Please ask the merchant for a fresh payment link.</div>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

export default function PublicPayPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = use(params);
  // Self-contained QueryClient — this public page renders outside the admin
  // Providers tree (it's a standalone shell).
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }));
  // Default this page to the dark theme regardless of the operator's toggle.
  useEffect(() => { document.documentElement.classList.add("dark"); }, []);
  return (
    <QueryClientProvider client={qc}>
      <PaymentInner orderId={orderId} />
    </QueryClientProvider>
  );
}
