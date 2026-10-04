"use client";

// The merchant's pay-in accounts side by side: one column per channel and "All", which is the sum
// of them (lib/channel-accounts). The selected channel's column is highlighted; the others stay
// visible so a total can always be taken apart into the rail each rupee belongs to.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatAmount } from "@/lib/utils";
import { PAYIN_CHANNEL_LABEL, type PayinChannel } from "@/lib/payin-channel";
import type { ChannelAccount } from "@/lib/channel-accounts";
import type { ChannelFilter } from "@/components/payin/channel";

type Row = { label: string; hint?: string; value: (a: ChannelAccount) => React.ReactNode; strong?: boolean };

const money = (n: number | null) => (n == null ? "—" : formatAmount(n));

const ROWS: Row[] = [
  { label: "Gross pay-in", hint: "Paid pay-ins, plus money received with no order", value: (a) => money(a.gross), strong: true },
  { label: "Successful", value: (a) => `${a.paid.count} · ${formatAmount(a.paid.amount)}` },
  { label: "Received, no order", value: (a) => (a.received_no_order ? formatAmount(a.received_no_order) : "—") },
  { label: "Pending", value: (a) => `${a.pending.count} · ${formatAmount(a.pending.amount)}` },
  { label: "Success rate", hint: "Paid out of paid + failed / expired", value: (a) => (a.success_rate == null ? "—" : `${a.success_rate}%`) },
  { label: "Fees", hint: "By your rate card for the channel", value: (a) => (a.fee_rated ? formatAmount(a.fees) : a.paid.count ? "No rate set" : "—") },
  { label: "Chargeback debits", hint: "Debited, net of what was given back", value: (a) => (a.chargeback_debits ? `− ${formatAmount(a.chargeback_debits)}` : "—") },
  { label: "Net", hint: "Gross − fees − chargeback debits", value: (a) => money(a.net), strong: true },
  { label: "Settled", hint: "Covered by your bankers' verified settlements", value: (a) => money(a.settled) },
  { label: "Unsettled", value: (a) => money(a.unsettled) },
  { label: "Recon variance", hint: "Money in exceptions: amount or status differs, no evidence, no order, duplicate, over-settled", value: (a) => money(a.variance) },
  { label: "Chargebacks", value: (a) => (a.chargebacks.count ? `${a.chargebacks.count} · ${formatAmount(a.chargebacks.amount)}` : "—") },
  { label: "Chargeback ratio", hint: "Chargebacks per paid pay-in", value: (a) => (a.chargebacks.ratio == null || !a.chargebacks.count ? "—" : `${a.chargebacks.ratio}%`) },
];

export function ChannelAccountsTable({ channels, total, selected, loading, livemode = true, title = "By channel", description }: {
  channels?: Record<PayinChannel, ChannelAccount>;
  total?: ChannelAccount;
  selected: ChannelFilter;
  loading?: boolean;
  livemode?: boolean;
  title?: string;
  description?: string;
}) {
  // An Unclassified column appears only when such rows exist, so legacy records stay visible.
  const u = channels?.UNCLASSIFIED;
  const showU = !!u && (u.paid.count + u.pending.count + u.failed.count + u.recon.SETTLEMENT_MISMATCH.count + u.chargebacks.count) > 0;
  const cols: { key: PayinChannel | "ALL"; label: string; a?: ChannelAccount }[] = [
    { key: "INTENT", label: PAYIN_CHANNEL_LABEL.INTENT, a: channels?.INTENT },
    { key: "P2P", label: PAYIN_CHANNEL_LABEL.P2P, a: channels?.P2P },
    ...(showU ? [{ key: "UNCLASSIFIED" as const, label: PAYIN_CHANNEL_LABEL.UNCLASSIFIED, a: u }] : []),
    { key: "ALL", label: "All channels", a: total },
  ];
  const active = (k: string) => (selected ? k === selected : k === "ALL");
  const rows = livemode ? ROWS : ROWS.filter((r) => r.label !== "Settled" && r.label !== "Unsettled");

  return (
    <Card className="mb-6">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>
          {description ?? "Each channel is worked out from its own pay-ins; All is their sum."}
          {!livemode && " Test mode: settlement applies to live money only."}
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b border-[color:var(--color-border)] text-left text-xs text-[color:var(--color-text-muted)]">
              <th className="py-2 pr-3 font-medium" />
              {cols.map((c) => (
                <th key={c.key} className={cn("px-3 py-2 text-right font-medium", active(c.key) && "text-[color:var(--color-brand)]")}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-[color:var(--color-border)] last:border-0">
                <td className="py-1.5 pr-3 text-[color:var(--color-text-muted)]" title={r.hint}>{r.label}</td>
                {cols.map((c) => (
                  <td key={c.key} className={cn("px-3 py-1.5 text-right tabular-nums", r.strong && "font-semibold",
                    active(c.key) && "bg-[color:var(--color-brand-muted)]/40")}>
                    {loading || !c.a ? "—" : r.value(c.a)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
