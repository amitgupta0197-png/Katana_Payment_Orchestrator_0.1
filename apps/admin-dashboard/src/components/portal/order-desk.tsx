"use client";

// The order desk (lib/order-timeline): one search box across Katana's order id, the merchant's
// own reference and the bank reference, and the timeline of the order it finds — as created,
// each status change, each webhook delivery attempt, with Resend.
//
// Shared by the merchant portal, the banker portal and the staff dashboard; `base` is the
// page it is mounted on. What staff see beyond a merchant (who made each change, on what
// evidence, the receiving server's answer) is decided by the API, not here.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, ArrowLeft, Clock, Send, RotateCw, Copy } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";
import { TestEventButton } from "@/components/portal/test-event-button";
import { usePortal } from "@/components/portal/portal-frame";
import { PaymentStatus } from "@/components/portal/plain-status";
import { PaidButton } from "@/components/portal/paid-button";

/** A merchant or banker reads Paid / Waiting / Failed / Expired; staff keep the v2 words. */
function DeskStatus({ status }: { status: string }) {
  return usePortal() ? <PaymentStatus status={status} /> : <Badge variant={statusVariant(status)}>{status}</Badge>;
}

interface Hit {
  id: string; order_id: string; reference: string; status: string; amount: number;
  merchant_id: string | null; flow: string | null; livemode: boolean; created_at: string; rrn: string | null;
}
interface Step { at: string; from: string | null; to: string; label: string; actor?: string | null; evidence?: string | null; request_id?: string | null }
interface Attempt { attempt_no: number; sent_at: string; http_status: number | null; latency_ms: number | null; error: string | null; response_body?: string | null }
interface Delivery {
  outbox_id: string; event: string; version: string; event_id: string | null; status: string; target_url: string;
  created_at: string; next_attempt_at: string | null; resend_of: string | null; requested_by: string | null; attempts: Attempt[];
}
interface Timeline {
  staff: boolean;
  order: Hit & { expires_at: string | null; paid_at: string | null; rrn_is_synthetic: boolean; previous_status: string | null; callback_url: string | null; api_version: string };
  steps: Step[]; deliveries: Delivery[];
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? d.message ?? "HTTP " + r.status);
  return d as T;
}

function CopyBtn({ value }: { value: string }) {
  return (
    <button onClick={() => { navigator.clipboard.writeText(value); toast.success("Copied"); }}
      className="ml-1.5 inline-flex align-middle opacity-50 hover:opacity-100" aria-label="Copy">
      <Copy className="h-3 w-3" />
    </button>
  );
}

export function OrderSearch({ base }: { base: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  // Before anything is searched, the newest orders.
  const res = useQuery({
    queryKey: ["order-desk:search", q],
    enabled: q.length >= 3 || q === "",
    queryFn: () => getJson<{ orders: Hit[] }>(`/api/portal/orders?q=${encodeURIComponent(q)}`),
  });
  const hits = res.data?.orders ?? [];
  // One exact answer is what the search was for: go straight to it.
  const only = hits.length === 1 && [hits[0].order_id, hits[0].reference, hits[0].rrn, hits[0].id].includes(q) ? hits[0] : null;
  const onlyId = only?.order_id;
  useEffect(() => { if (onlyId) router.replace(`${base}/${onlyId}`); }, [onlyId, base, router]);

  return (
    <>
      <PageHeader title="Orders" icon={Search}
        description="Your newest orders. Search by your order number, Katana's order id or the bank reference (UTR)." />
      <Card>
        <CardContent className="pt-6">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setQ(text.trim()); }}>
            <Input autoFocus value={text} onChange={(e) => setText(e.target.value)}
              placeholder="Order number, KTN_… or 12-digit UTR" aria-label="Order number, order id or bank reference" />
            <Button type="submit" disabled={text.trim().length < 3}><Search className="h-4 w-4" /> Search</Button>
          </form>
          {(q.length >= 3 || q === "") && (
            <div className="mt-4">
              {q === "" && hits.length > 0 && <p className="mb-2 text-sm text-[color:var(--color-text-muted)]">Newest orders</p>}
              {res.isLoading ? <p className="text-sm text-[color:var(--color-text-muted)]">Searching…</p>
                : res.error ? <p className="text-sm text-[color:var(--color-danger)]">{(res.error as Error).message}</p>
                : hits.length === 0 ? <p className="text-sm text-[color:var(--color-text-muted)]">{q ? `No order matches “${q}”.` : "No orders yet."}</p>
                : (
                  <ul className="divide-y divide-[color:var(--color-border)] rounded-md border">
                    {hits.map((h) => (
                      <li key={h.id} className="flex flex-wrap items-center gap-2 pr-3 hover:bg-[color:var(--color-surface-muted)]">
                        <Link href={`${base}/${h.order_id}`} className="flex min-h-12 min-w-0 flex-1 flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                          <DeskStatus status={h.status} />
                          <span className="font-medium tabular-nums">{formatAmount(h.amount)}</span>
                          <span className="font-mono text-xs">{h.reference}</span>
                          {!h.livemode && <Badge variant="warning">TEST</Badge>}
                          <span className="ml-auto text-xs text-[color:var(--color-text-muted)]">{h.merchant_id} · {formatDateTime(h.created_at)}</span>
                        </Link>
                        <PaidButton txnid={h.reference} status={h.status} compact />
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[color:var(--color-border)] py-2 text-sm last:border-0">
      <span className="text-[color:var(--color-text-muted)]">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

const DELIVERY_VARIANT: Record<string, "success" | "warning" | "danger" | "default"> = {
  DELIVERED: "success", PENDING: "warning", DEAD_LETTER: "danger", TEST_FAILED: "danger",
};
const DELIVERY_LABEL: Record<string, string> = {
  DELIVERED: "Delivered", PENDING: "Retrying", DEAD_LETTER: "Gave up", TEST_FAILED: "Failed",
};

export function DeliveryList({ deliveries, staff, onResend, resending }: {
  deliveries: Delivery[]; staff: boolean; onResend?: (outboxId: string) => void; resending?: boolean;
}) {
  if (!deliveries.length) return <p className="py-4 text-center text-sm text-[color:var(--color-text-muted)]">No webhook has been sent yet.</p>;
  return (
    <ul className="space-y-3">
      {deliveries.map((d) => (
        <li key={d.outbox_id} className="rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-xs font-medium">{d.event}</span>
            <Badge variant={DELIVERY_VARIANT[d.status] ?? "default"}>{DELIVERY_LABEL[d.status] ?? d.status}</Badge>
            <Badge>{d.version}</Badge>
            {d.resend_of && <Badge variant="info">resend</Badge>}
            {onResend && (
              <Button size="sm" variant="secondary" className="ml-auto" disabled={resending} onClick={() => onResend(d.outbox_id)}>
                <RotateCw className="h-3.5 w-3.5" /> Resend
              </Button>
            )}
          </div>
          <div className="mt-1 break-all text-xs text-[color:var(--color-text-muted)]">
            to {d.target_url}{d.event_id ? ` · ${d.event_id}` : ""}{d.next_attempt_at ? ` · next attempt ${formatDateTime(d.next_attempt_at)}` : ""}
            {staff && d.requested_by ? ` · by ${d.requested_by}` : ""}
          </div>
          {d.attempts.length === 0 ? (
            <p className="mt-2 text-xs text-[color:var(--color-text-muted)]">Queued; not attempted yet.</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[color:var(--color-text-muted)]">
                  <tr><th className="py-1 pr-3 font-medium">Attempt</th><th className="py-1 pr-3 font-medium">Sent at</th><th className="py-1 pr-3 font-medium">Your server answered</th><th className="py-1 font-medium">Latency</th></tr>
                </thead>
                <tbody>
                  {d.attempts.map((a) => (
                    <tr key={a.attempt_no} className="border-t border-[color:var(--color-border)] align-top">
                      <td className="py-1 pr-3 tabular-nums">{a.attempt_no}</td>
                      <td className="py-1 pr-3">{formatDateTime(a.sent_at)}</td>
                      <td className="py-1 pr-3">
                        {a.http_status
                          ? <Badge variant={a.http_status < 300 ? "success" : "danger"}>HTTP {a.http_status}</Badge>
                          : <span className="text-[color:var(--color-danger)]">no answer{a.error ? `: ${a.error}` : ""}</span>}
                        {staff && a.response_body && <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-[color:var(--color-surface-muted)] p-1.5">{a.response_body}</pre>}
                      </td>
                      <td className="py-1 tabular-nums">{a.latency_ms != null ? `${a.latency_ms} ms` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function OrderTimelineView({ id, base }: { id: string; base: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["order-desk:order", id],
    queryFn: () => getJson<Timeline>(`/api/portal/orders/${encodeURIComponent(id)}`),
    refetchInterval: (query) => (query.state.data?.order.status === "PENDING" ? 15_000 : false),
  });
  const resend = useMutation({
    mutationFn: (outbox_id: string) => getJson<{ result: { ok: boolean; http_status: number | null; error: string | null } }>(
      `/api/portal/orders/${encodeURIComponent(id)}/resend`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outbox_id }) }),
    onSuccess: (d) => {
      if (d.result.ok) toast.success(`Resent: your server answered HTTP ${d.result.http_status}`);
      else toast.error("Resent, but not accepted", { description: d.result.error ?? "no answer" });
      qc.invalidateQueries({ queryKey: ["order-desk:order", id] });
    },
    onError: (e: Error) => toast.error("Not resent", { description: e.message }),
  });

  const back = <Button asChild size="sm" variant="secondary"><Link href={base}><ArrowLeft className="h-4 w-4" /> Search</Link></Button>;
  if (q.isLoading) return <div className="py-10 text-center text-sm text-[color:var(--color-text-muted)]">Loading…</div>;
  if (q.error || !q.data) return (
    <>
      <PageHeader title="Order" icon={Clock} actions={back} />
      <Card><CardContent className="py-8 text-center text-sm">
        {(q.error as Error)?.message === "not found" ? "That order is not in your account." : (q.error as Error)?.message ?? "Not found"}
      </CardContent></Card>
    </>
  );
  const { order: o, steps, deliveries, staff } = q.data;

  return (
    <>
      <PageHeader title="Order" description={o.reference} icon={Clock} actions={back} />

      <Card className="mb-4">
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-3xl font-semibold tabular-nums">{formatAmount(o.amount)}</span>
            <DeskStatus status={o.status} />
            {!o.livemode && <Badge variant="warning">TEST</Badge>}
            <PaidButton txnid={o.reference} status={o.status} className="ml-auto" />
            {o.previous_status && <span className="text-xs text-[color:var(--color-text-muted)]">paid after it had {o.previous_status === "EXPIRED" ? "expired" : "failed"}</span>}
          </div>
          <div className="mt-3 grid grid-cols-1 gap-x-8 lg:grid-cols-2">
            <div>
              <Row label="Order id"><span className="font-mono text-xs">{o.order_id}</span><CopyBtn value={o.order_id} /></Row>
              <Row label="Your reference"><span className="font-mono text-xs">{o.reference}</span><CopyBtn value={o.reference} /></Row>
              <Row label="Flow">{o.flow ?? "—"}</Row>
              <Row label="Account"><span className="font-mono text-xs">{o.merchant_id ?? "—"}</span></Row>
            </div>
            <div>
              <Row label="Created">{formatDateTime(o.created_at)}</Row>
              <Row label={o.status === "PENDING" ? "Expires" : "Paid at"}>{formatDateTime(o.status === "PENDING" ? o.expires_at : o.paid_at)}</Row>
              <Row label="Bank reference (UTR)">
                {o.rrn ? <><span className="font-mono text-xs">{o.rrn}</span><CopyBtn value={o.rrn} /></> : "—"}
                {o.rrn && o.rrn_is_synthetic && <div className="text-xs text-[color:var(--color-warning)]">made by Katana: not on a bank statement</div>}
              </Row>
              <Row label="Created through">API {o.api_version}</Row>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="inline-flex items-center gap-2 text-base"><Clock className="h-4 w-4" />Status history</CardTitle>
            <CardDescription>Every status the order has had, oldest first.</CardDescription></CardHeader>
          <CardContent>
            {steps.length === 0 ? <p className="py-4 text-center text-sm text-[color:var(--color-text-muted)]">No status change recorded.</p> : (
              <ol className="space-y-3">
                {steps.map((s, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[color:var(--color-brand)]" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <DeskStatus status={s.to} />
                        <span>{s.label}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-[color:var(--color-text-muted)]">
                        {formatDateTime(s.at)}
                        {staff && (s.actor || s.evidence) && <span className="font-mono"> · {[s.evidence, s.actor].filter(Boolean).join(" · ")}</span>}
                        {staff && s.request_id && <span className="font-mono"> · {s.request_id}</span>}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="inline-flex items-center gap-2 text-base"><Send className="h-4 w-4" />Webhook deliveries</CardTitle>
            <CardDescription>Each attempt to tell your server. Resend queues the same event again with a new event id.</CardDescription></CardHeader>
          <CardContent>
            {o.merchant_id && (
              <div className="mb-3 flex flex-wrap items-center gap-2 border-b pb-3">
                <TestEventButton merchantCode={o.merchant_id} />
                <span className="text-xs text-[color:var(--color-text-muted)]">A sample goes to the saved callback URL. It is not this order and does not change it.</span>
              </div>
            )}
            <DeliveryList deliveries={deliveries} staff={staff} onResend={(x) => resend.mutate(x)} resending={resend.isPending} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
