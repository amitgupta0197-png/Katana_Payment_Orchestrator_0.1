"use client";

// Banker-side chargebacks against Katana Pay pay-ins, for the merchant portal, the banker portal
// and staff (/api/chargebacks, scoped on the server). A chargeback is a separate dimension from the
// pay-in: the original payment keeps its gross, and what was charged back, what was debited under
// the merchant's terms and what was given back are shown beside it, per channel.
//
// `staff` adds the source, the problems with the chain and the actions (components/chargebacks/
// chargeback-actions); merchants and bankers read only.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { ChannelBadge, ChannelSwitch, type ChannelFilter } from "@/components/payin/channel";
import { formatAmount, formatDateTime } from "@/lib/utils";
import { CB_LABEL, CB_STATES, cbVariant, type CbState } from "@/lib/chargeback-rules";
import type { PayinChannel } from "@/lib/payin-channel";
import type { StaffChargeback } from "@/lib/chargeback-view";

export interface CbTotalsView {
  count: number; amount: number; debited: number; reversed: number; net_debited: number; pending_debit: number; open: number;
  paid: number; ratio: number | null;
}
type Row = StaffChargeback;   // a merchant gets the same shape without the staff fields

const fetchJson = async (url: string, init?: RequestInit) => fetch(url, init).then(async (r) => {
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
  return d;
});

export function ChargebacksList({ staff = false, renderActions }: {
  staff?: boolean;
  /** Staff only: what to show under an expanded row (the actions and the chain). */
  renderActions?: (row: Row, refresh: () => void) => React.ReactNode;
}) {
  const [channel, setChannel] = useState<ChannelFilter>("");
  const [state, setState] = useState<CbState | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (channel) params.set("channel", channel);
  if (state) params.set("state", state);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (q.trim()) params.set("q", q.trim());
  const qs = params.toString();

  const list = useQuery({
    queryKey: ["chargebacks", qs],
    queryFn: async () => (await fetchJson(`/api/chargebacks${qs ? `?${qs}` : ""}`)) as {
      chargebacks: Row[]; totals: Record<PayinChannel, CbTotalsView>;
    },
    refetchInterval: 60_000,
  });
  const terms = useQuery({
    queryKey: ["chargeback-terms"],
    enabled: !staff,
    queryFn: async () => (await fetchJson("/api/chargebacks/rules")) as {
      rules: { channel: string | null; banker: string | null; reason_code: string | null; debit_ratio: string; version: number; since: string }[];
    },
  });

  const t = list.data?.totals;
  const sel = (k: keyof CbTotalsView) => {
    const chans: PayinChannel[] = channel ? [channel] : ["INTENT", "P2P", "UNCLASSIFIED"];
    return chans.reduce((a, c) => a + Number(t?.[c]?.[k] ?? 0), 0);
  };
  const count = sel("count"), paid = sel("paid");
  const ratio = count && paid ? Math.round((count / paid) * 10000) / 100 : null;

  const cols: Column<Row>[] = [
    { key: "received_at", header: "Received", render: (r) => <span className="text-xs tabular-nums">{formatDateTime(r.received_at)}</span> },
    { key: "channel", header: "Channel", render: (r) => (r.channel ? <ChannelBadge channel={r.channel} /> : <span className="text-xs text-[color:var(--color-text-muted)]">—</span>) },
    { key: "banker", header: "Banker", render: (r) => <span className="font-mono text-xs">{r.banker ?? "—"}</span> },
    { key: "order_ref", header: "Original pay-in", render: (r) => r.order_ref
        ? <span className="text-xs"><span className="font-mono">{r.order_ref}</span>{r.order_amount != null && <span className="text-[color:var(--color-text-muted)]"> · {formatAmount(r.order_amount)}{r.order_date ? ` · ${formatDateTime(r.order_date)}` : ""}</span>}</span>
        : <span className="text-xs text-[color:var(--color-text-muted)]">not found yet</span> },
    { key: "original_ref", header: "UTR / RRN", render: (r) => <span className="font-mono text-xs">{r.original_ref ?? r.order_utr ?? "—"}</span> },
    { key: "bank_ref", header: "Bank's reference", render: (r) => <span className="font-mono text-xs">{r.bank_ref}</span> },
    { key: "amount", header: "Chargeback", render: (r) => <span className="tabular-nums">{formatAmount(r.amount)}</span> },
    { key: "debit_ratio", header: "Ratio", render: (r) => r.debit_ratio ?? "—" },
    { key: "calculated_debit", header: "Calculated", render: (r) => (r.calculated_debit == null ? "—" : <span className="tabular-nums">{formatAmount(r.calculated_debit)}</span>) },
    { key: "net_debited", header: "Debited", render: (r) => (
        <span className="tabular-nums">{r.debited ? formatAmount(r.net_debited) : "—"}{r.reversed > 0 && <span className="text-xs text-[color:var(--color-text-muted)]"> ({formatAmount(r.reversed)} back)</span>}</span>
      ) },
    { key: "reason_code", header: "Reason", render: (r) => <span className="text-xs">{r.reason_code ?? "—"}{r.reason ? <span className="text-[color:var(--color-text-muted)]"> · {r.reason}</span> : null}</span> },
    { key: "state", header: "State", render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <Badge variant={cbVariant(r.state)}>{staff ? r.state : CB_LABEL[r.state]}</Badge>
          {r.reconciled ? <Badge variant="default">reconciled</Badge> : null}
        </span>
      ) },
  ];

  const refresh = () => { void list.refetch(); };

  return (
    <>
      <Card className="mb-6">
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div><Label className="text-xs">Pay-in channel</Label><div><ChannelSwitch value={channel} onChange={setChannel} /></div></div>
          <div className="min-w-[9rem]"><Label className="text-xs">Received from</Label><Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="min-w-[9rem]"><Label className="text-xs">To</Label><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="min-w-[10rem]"><Label className="text-xs">State</Label>
            <select value={state} onChange={(e) => setState(e.target.value as CbState | "")}
              className="w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm">
              <option value="">Every state</option>
              {CB_STATES.map((s) => <option key={s} value={s}>{staff ? s : CB_LABEL[s]}</option>)}
            </select>
          </div>
          <div className="min-w-[12rem] flex-1"><Label className="text-xs">Reference</Label><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="UTR, order id, bank or CB- reference" /></div>
          {(from || to || state || q) && <Button variant="ghost" size="sm" onClick={() => { setFrom(""); setTo(""); setState(""); setQ(""); }}><X className="h-4 w-4" /> Clear</Button>}
          <Button asChild variant="secondary" size="sm"><a href={`/api/chargebacks?${new URLSearchParams({ ...Object.fromEntries(params), format: "csv" })}`}><Download className="h-4 w-4" /> CSV</a></Button>
        </CardContent>
      </Card>

      {list.isError && (
        <Card className="mb-6"><CardContent className="py-6 text-center text-sm text-[color:var(--color-danger)]">
          Couldn’t load chargebacks: {(list.error as Error)?.message}
        </CardContent></Card>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Chargebacks received" value={formatAmount(sel("amount"))} sublabel={`${count} chargeback${count === 1 ? "" : "s"}`} loading={list.isLoading} />
        <KpiTile label="Chargeback ratio" value={ratio == null ? "—" : `${ratio}%`} sublabel={`of ${paid} paid pay-ins`} variant={ratio != null && ratio >= 1 ? "warning" : "default"} loading={list.isLoading} />
        <KpiTile label="Debited" value={formatAmount(sel("debited"))} sublabel={`${formatAmount(sel("reversed"))} given back`} variant={sel("debited") > 0 ? "danger" : "default"} loading={list.isLoading} />
        <KpiTile label="Pending debit" value={formatAmount(sel("pending_debit"))} sublabel={`${sel("open")} not yet decided`} variant={sel("open") > 0 ? "warning" : "default"} loading={list.isLoading} />
      </div>

      {!channel && (
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {(["INTENT", "P2P"] as const).map((c) => {
            const x = t?.[c];
            return (
              <Card key={c}>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-base">{c} chargebacks</CardTitle><ChannelBadge channel={c} />
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    {([
                      ["Received", x ? `${x.count} · ${formatAmount(x.amount)}` : "—"],
                      ["Ratio", x?.ratio == null ? "—" : `${x.ratio}%`],
                      ["Debited (net)", x ? formatAmount(x.net_debited) : "—"],
                      ["Given back", x ? formatAmount(x.reversed) : "—"],
                      ["Pending debit", x ? formatAmount(x.pending_debit) : "—"],
                      ["Not yet decided", x?.open ?? 0],
                    ] as [string, React.ReactNode][]).map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between gap-2 border-b border-[color:var(--color-border)] py-1">
                        <dt className="text-[color:var(--color-text-muted)]">{k}</dt><dd className="font-medium tabular-nums">{list.isLoading ? "—" : v}</dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Chargebacks</CardTitle>
          <CardDescription>
            Newest first. Each is matched to the original payment in its own channel. Your gross pay-in is never changed; a debit is shown here and on the payment.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={list.data?.chargebacks ?? []}
            rowKey={(r) => r.id}
            loading={list.isLoading}
            onRowClick={(r) => setOpenId(openId === r.id ? null : r.id)}
            isExpanded={(r) => openId === r.id}
            renderExpanded={(r) => staff && renderActions ? renderActions(r, refresh) : <ChargebackChain id={r.id} explanation={r.explanation} />}
            emptyState={qs ? "No chargebacks match this filter." : "No chargebacks. Good."}
          />
        </CardContent>
      </Card>

      {!staff && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your chargeback terms</CardTitle>
            <CardDescription>How much of a chargeback is debited to you, as agreed with Katana. A chargeback with no terms is never debited until they are set.</CardDescription>
          </CardHeader>
          <CardContent>
            {(terms.data?.rules ?? []).length === 0 ? (
              <p className="text-sm text-[color:var(--color-text-muted)]">{terms.isLoading ? "Loading…" : "No terms set yet."}</p>
            ) : (
              <ul className="text-sm">
                {terms.data!.rules.map((r, i) => (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--color-border)] py-1.5 last:border-0">
                    <span>
                      {r.channel ? `${r.channel} pay-ins` : "Every pay-in"}{r.banker ? ` of ${r.banker}` : ""}{r.reason_code ? `, reason ${r.reason_code}` : ""}
                    </span>
                    <span className="font-medium tabular-nums">{r.debit_ratio} debited <span className="text-xs font-normal text-[color:var(--color-text-muted)]">· version {r.version}, since {formatDateTime(r.since)}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}

/** The chain of one chargeback as a merchant sees it: what happened, and every entry posted. */
export function ChargebackChain({ id, explanation }: { id: string; explanation: string }) {
  const q = useQuery({
    queryKey: ["chargeback", id],
    queryFn: async () => (await fetchJson(`/api/chargebacks/${id}`)) as {
      postings: { kind: string; amount: number; at: string; basis: string }[];
      events: { label: string; at: string }[];
    },
  });
  return (
    <div className="space-y-3 text-sm">
      <p>{explanation}</p>
      <ol className="space-y-2">
        {(q.data?.events ?? []).map((e, i) => (
          <li key={i} className="flex gap-3">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[color:var(--color-brand)]" />
            <span>{e.label} <span className="text-xs text-[color:var(--color-text-muted)]">· {formatDateTime(e.at)}</span></span>
          </li>
        ))}
      </ol>
      {(q.data?.postings ?? []).length > 0 && (
        <ul className="rounded-md border border-[color:var(--color-border)] p-2 text-xs">
          {q.data!.postings.map((p, i) => (
            <li key={i} className="flex justify-between gap-3 py-0.5">
              <span>{p.kind === "CHARGEBACK_DEBIT" ? "Debit" : "Given back"} · {p.basis} · {formatDateTime(p.at)}</span>
              <span className="tabular-nums font-medium">{p.kind === "CHARGEBACK_DEBIT" ? "−" : "+"} {formatAmount(p.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
