"use client";

// Download transaction statement — the period picker and the file it produces.
//
// One component for all three portals; the only difference is which endpoint it points at
// and therefore what the server scopes the rows to. It never receives rows itself: the
// preview call returns counts and totals only, and the file is fetched by the browser as
// an ordinary download so a large statement never has to pass through React state.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileSpreadsheet, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatAmount } from "@/lib/utils";
import {
  PERIOD_OPTIONS, CHANNEL_LABELS, IST_OFFSET_MS,
  type StatementChannel, type StatementPeriod,
} from "@/lib/statement";

interface Preview {
  label: string; count: number; gross: number; fee: number; net: number;
  /** Credits with no UPI reference yet: in the file, excluded from gross/fee/net. */
  awaiting_count?: number; awaiting_gross?: number;
  checkout_count: number; vpa_count: number; filename: string;
}

/** Today's IST calendar date as `YYYY-MM-DD`, for the custom-range defaults. */
function istToday(offsetDays = 0): string {
  return new Date(Date.now() + IST_OFFSET_MS + offsetDays * 86400000).toISOString().slice(0, 10);
}

const CHANNELS: StatementChannel[] = ["ALL", "CHECKOUT", "VPA"];

export function DownloadStatement({
  endpoint,
  description = "Pick a period and download the transactions as a CSV.",
  extraParams,
  children,
}: {
  /** Statement API for this portal, e.g. `/api/merchant-portal/statement`. */
  endpoint: string;
  description?: string;
  /** Extra query parameters this portal adds, e.g. an admin's banker-code filter. */
  extraParams?: Record<string, string>;
  /** Portal-specific controls, rendered above the period picker. */
  children?: React.ReactNode;
}) {
  const [period, setPeriod] = useState<StatementPeriod>("yesterday");
  const [channel, setChannel] = useState<StatementChannel>("ALL");
  const [from, setFrom] = useState(istToday().slice(0, 8) + "01");
  const [to, setTo] = useState(istToday());

  const params = new URLSearchParams({ period, channel });
  if (period === "custom") { params.set("from", from); params.set("to", to); }
  for (const [k, v] of Object.entries(extraParams ?? {})) params.set(k, v);
  const qs = params.toString();

  const preview = useQuery({
    queryKey: ["statement:preview", endpoint, qs],
    queryFn: async () => {
      const r = await fetch(`${endpoint}?${qs}&preview=1`);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
      return d as Preview;
    },
  });

  const empty = preview.data?.count === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Download transaction statement</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div>
            {children}
            <fieldset>
              <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
                Select a statement period
              </legend>
              <div className="flex flex-col gap-1">
                {PERIOD_OPTIONS.map((o) => (
                  <label
                    key={o.value}
                    className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2.5 text-sm hover:bg-[color:var(--color-surface-muted)]"
                  >
                    <input
                      type="radio"
                      name="statement-period"
                      className="h-4 w-4 accent-[color:var(--color-brand)]"
                      checked={period === o.value}
                      onChange={() => setPeriod(o.value)}
                    />
                    <span className="flex-1">{o.label}</span>
                    {period === o.value && preview.data && (
                      <span className="text-xs text-[color:var(--color-text-muted)]">{preview.data.label}</span>
                    )}
                  </label>
                ))}
              </div>
            </fieldset>

            {period === "custom" && (
              <div className="mt-2 flex flex-wrap gap-3 pl-9">
                <label className="flex flex-col gap-1 text-xs text-[color:var(--color-text-muted)]">
                  Start date
                  <input
                    type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
                    className="h-9 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 text-sm text-[color:var(--color-text)]"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-[color:var(--color-text-muted)]">
                  End date
                  <input
                    type="date" value={to} min={from} max={istToday()} onChange={(e) => setTo(e.target.value)}
                    className="h-9 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 text-sm text-[color:var(--color-text)]"
                  />
                </label>
              </div>
            )}

            <div className="mt-5">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
                Channel
              </div>
              <div className="flex flex-wrap gap-2">
                {CHANNELS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setChannel(c)}
                    aria-pressed={channel === c}
                    className={`rounded-full border px-3 py-1.5 text-xs transition ${
                      channel === c
                        ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand)]/10 text-[color:var(--color-text)]"
                        : "border-[color:var(--color-border)] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]"
                    }`}
                  >
                    {CHANNEL_LABELS[c]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* What the file will contain, before it is written. */}
          <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface-muted)] p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
              <FileSpreadsheet className="h-3.5 w-3.5" /> This statement
            </div>

            {preview.isError ? (
              <p className="mt-3 text-sm text-[color:var(--color-danger)]">{(preview.error as Error).message}</p>
            ) : (
              <dl className="mt-3 flex flex-col gap-2 text-sm">
                <Row label="Period" value={preview.data?.label ?? "…"} />
                <Row label="Transactions" value={preview.isLoading ? "…" : String(preview.data?.count ?? 0)} />
                <Row label="Gross · RRN verified" value={preview.isLoading ? "…" : formatAmount(preview.data?.gross ?? 0)} />
                <Row label="Processing fee" value={preview.isLoading ? "…" : formatAmount(preview.data?.fee ?? 0)} />
                <Row label="Net" value={preview.isLoading ? "…" : formatAmount(preview.data?.net ?? 0)} strong />
                {/* Credits still without a UPI reference are quoted apart from the totals above
                    — unproven money must not read as banked money — but they ARE in the file, so
                    say so rather than letting the numbers look like they disagree. */}
                {!preview.isLoading && (preview.data?.awaiting_count ?? 0) > 0 && (
                  <>
                    <Row label="Awaiting RRN (not in Gross)" value={formatAmount(preview.data?.awaiting_gross ?? 0)} />
                    <p className="text-xs text-[color:var(--color-text-muted)]">
                      {preview.data?.awaiting_count} credit{(preview.data?.awaiting_count ?? 0) === 1 ? "" : "s"} still
                      waiting on a UPI reference — listed in the file, excluded from the totals above.
                    </p>
                  </>
                )}
                {channel === "ALL" && preview.data && (
                  <p className="pt-1 text-xs text-[color:var(--color-text-muted)]">
                    {preview.data.checkout_count} merchant-hosted · {preview.data.vpa_count} gateway-hosted
                  </p>
                )}
              </dl>
            )}

            {/* A disabled <a> is still clickable, so an unavailable download is rendered as a
                real disabled button rather than a link that would fetch an empty file. */}
            {preview.isLoading || empty || preview.isError ? (
              <Button className="mt-4 w-full" disabled>
                {preview.isLoading
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Checking…</>
                  : <><Download className="h-4 w-4" /> Download</>}
              </Button>
            ) : (
              <Button asChild className="mt-4 w-full">
                <a href={`${endpoint}?${qs}`} download><Download className="h-4 w-4" /> Download</a>
              </Button>
            )}
            {empty && (
              <p className="mt-2 text-center text-xs text-[color:var(--color-text-muted)]">
                No transactions in this period.
              </p>
            )}
            {preview.data?.filename && !empty && (
              <p className="mt-2 truncate text-center text-xs text-[color:var(--color-text-subtle)]" title={preview.data.filename}>
                {preview.data.filename}
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-[color:var(--color-text-muted)]">{label}</dt>
      <dd className={`tabular-nums ${strong ? "font-semibold" : ""}`}>{value}</dd>
    </div>
  );
}
