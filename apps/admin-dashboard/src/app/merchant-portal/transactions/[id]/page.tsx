"use client";

// Single transaction detail — the same picture the gateway's own dashboard gives,
// so a merchant chasing "did this land?" never has to log in anywhere else.
//
// Fields the gateway did not send are shown as "—", never as zero. On a payments
// screen an invented ₹0.00 fee reads as fact; charges and GST usually only arrive at
// settlement, and until they do the honest answer is that we do not know yet.

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Receipt, ArrowLeft, Copy, ShieldCheck, ShieldAlert, Clock } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatAmount, formatDateTime, statusVariant, railLabel } from "@/lib/utils";

interface Detail {
  provider: string; provider_payment_id: string | null; bank_ref_num: string | null;
  payment_type: string | null; bank_name: string | null; card_masked: string | null;
  card_network: string | null; name_on_card: string | null; vpa: string | null;
  amount: number | null; net_amount_debit: number | null; gateway_fee: number | null;
  gateway_tax: number | null; settlement_amount: number | null; discount: number | null;
  customer_name: string | null; customer_email: string | null; customer_phone: string | null;
  gateway_status: string | null; error_code: string | null; error_message: string | null;
  udf: Record<string, string> | null; source: string; hash_verified: boolean | null;
  captured_at: string | null; updated_at: string;
}
interface Order {
  id: string; merchant_id: string; client_ref: string; txn_id: string | null; amount: number;
  currency: string; method: string; selected_rail: string | null; status: string;
  customer_email: string | null; created_at: string;
}
interface Transition {
  from_status: string | null; to_status: string; actor_kind: string;
  reason: string | null; payload: Record<string, unknown> | null; occurred_at: string;
}
interface Data { order: Order; detail: Detail | null; timeline: Transition[] }

const DASH = "—";

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[color:var(--color-border)] py-2 last:border-0">
      <span className="text-sm text-[color:var(--color-text-muted)]">{label}</span>
      <span className={`text-right text-sm ${mono ? "break-all font-mono text-xs" : ""}`}>{value ?? DASH}</span>
    </div>
  );
}

function Money({ v }: { v: number | null | undefined }) {
  return <span className="tabular-nums">{v === null || v === undefined ? DASH : formatAmount(v)}</span>;
}

function CopyBtn({ value }: { value: string }) {
  return (
    <button onClick={() => { navigator.clipboard.writeText(value); toast.success("Copied"); }}
      className="ml-1.5 inline-flex align-middle opacity-50 hover:opacity-100" aria-label="Copy">
      <Copy className="h-3 w-3" />
    </button>
  );
}

export default function TransactionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useQuery({
    queryKey: ["pp:txn", id],
    queryFn: async () => (await fetch(`/api/merchant-portal/transactions/${id}`).then(async (r) => {
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d;
    })) as Data,
    // A pending payment can settle at any moment — the reconciler sweeps every 15s.
    refetchInterval: (query) => (query.state.data?.order.status === "SUCCESS" ? false : 15_000),
  });

  if (q.isLoading) return <div className="py-10 text-center text-sm text-[color:var(--color-text-muted)]">Loading…</div>;
  if (q.error) return (
    <>
      <PageHeader title="Transaction" description="" icon={Receipt} />
      <Card><CardContent className="py-8 text-center text-sm">
        {String(q.error.message) === "not found" ? "That transaction is not in your account." : String(q.error.message)}
        <div className="mt-3"><Button asChild size="sm" variant="secondary"><Link href="/merchant-portal/transactions"><ArrowLeft className="h-4 w-4" /> Back</Link></Button></div>
      </CardContent></Card>
    </>
  );

  const { order: o, detail: d, timeline } = q.data!;
  const ref = o.txn_id ?? o.client_ref;

  return (
    <>
      <PageHeader title="Transaction" description={ref} icon={Receipt}
        actions={<Button asChild size="sm" variant="secondary"><Link href="/merchant-portal/transactions"><ArrowLeft className="h-4 w-4" /> All transactions</Link></Button>} />

      {/* Headline — amount and outcome, the two things anyone opens this page for */}
      <Card className="mb-4">
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-3xl font-semibold tabular-nums">{formatAmount(o.amount)}</span>
            <Badge variant={statusVariant(o.status)}>{o.status}</Badge>
            {d?.hash_verified === true && (
              <span className="inline-flex items-center gap-1 text-xs text-[color:var(--color-success)]">
                <ShieldCheck className="h-3.5 w-3.5" />signature verified
              </span>
            )}
            {d?.hash_verified === false && (
              <span className="inline-flex items-center gap-1 text-xs text-[color:var(--color-danger)]">
                <ShieldAlert className="h-3.5 w-3.5" />signature not verified
              </span>
            )}
          </div>
          <div className="mt-3 space-y-1 text-sm">
            {d?.provider_payment_id && <div><span className="text-[color:var(--color-text-muted)]">{d.provider} ID:</span> <span className="font-mono text-xs">{d.provider_payment_id}</span><CopyBtn value={d.provider_payment_id} /></div>}
            <div><span className="text-[color:var(--color-text-muted)]">Bank Ref:</span> <span className="font-mono text-xs">{d?.bank_ref_num ?? DASH}</span>{d?.bank_ref_num && <CopyBtn value={d.bank_ref_num} />}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Your reference:</span> <span className="font-mono text-xs">{ref}</span><CopyBtn value={ref} /></div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Payment breakup */}
        <Card>
          <CardHeader><CardTitle className="text-base">Payment breakup</CardTitle>
            <CardDescription>Deductions are reported by the gateway at settlement.</CardDescription></CardHeader>
          <CardContent className="py-0">
            <Row label="Amount" value={<Money v={o.amount} />} />
            <Row label="Amount debited" value={<Money v={d?.net_amount_debit} />} />
            <Row label="Discount / cashback" value={<Money v={d?.discount} />} />
            <Row label="Gateway charges" value={<Money v={d?.gateway_fee} />} />
            <Row label="GST" value={<Money v={d?.gateway_tax} />} />
            <Row label="Settlement amount" value={<Money v={d?.settlement_amount} />} />
          </CardContent>
        </Card>

        {/* Payment details */}
        <Card>
          <CardHeader><CardTitle className="text-base">Payment details</CardTitle>
            <CardDescription>How the money actually moved.</CardDescription></CardHeader>
          <CardContent className="py-0">
            <Row label="Payment type" value={d?.payment_type ?? o.method ?? DASH} />
            <Row label="Channel" value={o.selected_rail ? railLabel(o.selected_rail) : (d?.provider ?? DASH)} />
            <Row label="Bank ref no." value={d?.bank_ref_num ?? DASH} mono />
            <Row label="Bank name" value={d?.bank_name ?? DASH} />
            <Row label="UPI ID" value={d?.vpa ?? DASH} mono />
            <Row label="Card" value={d?.card_masked ?? DASH} mono />
            <Row label="Network" value={d?.card_network ?? DASH} />
            <Row label="Name on card" value={d?.name_on_card ?? DASH} />
            <Row label="Gateway status" value={d?.gateway_status ?? DASH} />
            <Row label="Error" value={d?.error_message ?? (o.status === "SUCCESS" ? "No error" : DASH)} />
          </CardContent>
        </Card>

        {/* Customer */}
        <Card>
          <CardHeader><CardTitle className="text-base">Customer</CardTitle></CardHeader>
          <CardContent className="py-0">
            <Row label="Name" value={d?.customer_name ?? DASH} />
            <Row label="Email" value={d?.customer_email ?? o.customer_email ?? DASH} />
            <Row label="Phone" value={d?.customer_phone ?? DASH} />
          </CardContent>
        </Card>

        {/* Order */}
        <Card>
          <CardHeader><CardTitle className="text-base">Order</CardTitle></CardHeader>
          <CardContent className="py-0">
            <Row label="Merchant reference" value={o.txn_id ?? DASH} mono />
            <Row label="Product info" value={o.client_ref || DASH} />
            <Row label="Currency" value={o.currency} />
            <Row label="Created" value={formatDateTime(o.created_at)} />
            <Row label="Captured" value={d?.captured_at ? formatDateTime(d.captured_at) : DASH} />
            <Row label="Banker" value={o.merchant_id} mono />
          </CardContent>
        </Card>
      </div>

      {/* Additional fields the gateway echoed back */}
      {d?.udf && Object.keys(d.udf).length > 0 && (
        <Card className="mt-4">
          <CardHeader><CardTitle className="text-base">Additional fields</CardTitle>
            <CardDescription>Extra values the gateway returned with this payment.</CardDescription></CardHeader>
          <CardContent className="py-0">
            {Object.entries(d.udf).map(([k, v]) => <Row key={k} label={k} value={v} mono />)}
          </CardContent>
        </Card>
      )}

      {/* Timeline */}
      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base inline-flex items-center gap-2"><Clock className="h-4 w-4" />History</CardTitle>
          <CardDescription>Every status change, and which channel reported it.</CardDescription></CardHeader>
        <CardContent>
          {timeline.length === 0 ? (
            <p className="py-4 text-center text-sm text-[color:var(--color-text-muted)]">No status changes recorded yet.</p>
          ) : (
            <ol className="space-y-3">
              {timeline.map((t, i) => (
                <li key={i} className="flex gap-3">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[color:var(--color-brand)]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge variant={statusVariant(t.to_status)}>{t.to_status}</Badge>
                      {t.from_status && <span className="text-xs text-[color:var(--color-text-muted)]">from {t.from_status}</span>}
                      <span className="text-xs text-[color:var(--color-text-muted)]">· {formatDateTime(t.occurred_at)}</span>
                    </div>
                    {t.reason && <div className="mt-0.5 text-xs text-[color:var(--color-text-muted)]">{t.reason} · reported by {t.actor_kind}</div>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {d && (
        <p className="mt-3 text-xs text-[color:var(--color-text-muted)]">
          Gateway detail last updated {formatDateTime(d.updated_at)} via {d.source.replace("_", " ")}.
        </p>
      )}
      {!d && (
        <p className="mt-3 text-xs text-[color:var(--color-text-muted)]">
          No gateway detail recorded for this order yet — it arrives with the payment result.
        </p>
      )}
    </>
  );
}
