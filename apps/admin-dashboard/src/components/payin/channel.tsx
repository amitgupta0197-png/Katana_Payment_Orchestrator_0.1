"use client";

// Pay-in channel controls shared by the merchant dashboard, Transactions and Reconciliation:
// the All / INTENT / P2P switch, the badge shown on every row, and the side-by-side cards
// that keep each rail's figures visible when All is selected.

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatAmount } from "@/lib/utils";
import { PAYIN_CHANNEL_LABEL, payinChannelOf, payinChannelVariant, type PayinChannel } from "@/lib/payin-channel";

/** "" means All channels. */
export type ChannelFilter = "" | "INTENT" | "P2P";

const OPTIONS: { value: ChannelFilter; label: string }[] = [
  { value: "", label: "All channels" }, { value: "INTENT", label: "INTENT" }, { value: "P2P", label: "P2P" },
];

export function ChannelSwitch({ value, onChange, className }: {
  value: ChannelFilter; onChange: (v: ChannelFilter) => void; className?: string;
}) {
  return (
    <div role="group" aria-label="Pay-in channel"
      className={cn("inline-flex rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-0.5", className)}>
      {OPTIONS.map((o) => (
        <button key={o.value || "ALL"} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}
          className={cn(
            "rounded px-3 py-1.5 text-sm font-medium transition-colors",
            value === o.value
              ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]"
              : "text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]",
          )}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ChannelBadge({ channel }: { channel: unknown }) {
  const c = payinChannelOf(channel);
  return <Badge variant={payinChannelVariant(c)}>{PAYIN_CHANNEL_LABEL[c]}</Badge>;
}

export interface ChannelStat { label: string; value: React.ReactNode }

/**
 * One card per channel, side by side. `stats` are that channel's own figures; an UNCLASSIFIED
 * card appears only when such rows exist, so legacy records stay visible until resolved.
 */
export function ChannelCards({ cards, loading }: {
  cards: { channel: PayinChannel; headline: number; headlineLabel: string; stats: ChannelStat[]; hidden?: boolean }[];
  loading?: boolean;
}) {
  const shown = cards.filter((c) => !c.hidden);
  return (
    <div className={cn("mb-6 grid grid-cols-1 gap-4", shown.length > 2 ? "lg:grid-cols-3" : "md:grid-cols-2")}>
      {shown.map((c) => (
        <Card key={c.channel}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">{PAYIN_CHANNEL_LABEL[c.channel]}</CardTitle>
            <ChannelBadge channel={c.channel} />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums">{loading ? "—" : formatAmount(c.headline)}</div>
            <div className="text-xs text-[color:var(--color-text-muted)]">{c.headlineLabel}</div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {c.stats.map((s) => (
                <div key={s.label} className="flex items-center justify-between gap-2 border-b border-[color:var(--color-border)] py-1">
                  <dt className="text-[color:var(--color-text-muted)]">{s.label}</dt>
                  <dd className="font-medium tabular-nums">{loading ? "—" : s.value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
