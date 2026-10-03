"use client";

// Find a payment (GET /api/portal/find): paste an order number, a UTR, an amount or the
// customer's phone, and each match is told as a short story (lib/payment-story).

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Banknote, Receipt, SearchX } from "lucide-react";
import { istTime, rupees, type PlainStatus } from "@/lib/plain-words";
import { PortalSearchBox, usePortal } from "@/components/portal/portal-frame";
import { StatusPill } from "@/components/portal/plain-status";
import { PaidButton } from "@/components/portal/paid-button";

const MUTED = "text-[color:var(--color-text-muted)]";

interface Found {
  kind: "order" | "money"; id: string; txnid: string | null; amount: number; status: PlainStatus; raw_status: string | null;
  livemode: boolean; at: string; account: string | null; utr: string | null; story: string[];
}

const KIND_WORDS: Record<string, string> = { utr: "a UTR", phone: "a phone number", amount: "an amount", reference: "an order number" };

export function FindView() {
  const portal = usePortal();
  const base = portal?.base ?? "/banker-portal";
  const q = useSearchParams().get("q") ?? "";
  const found = useQuery({
    queryKey: ["portal-find", q],
    enabled: !!q,
    queryFn: async () => {
      const r = await fetch(`/api/portal/find?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d as { kinds: string[]; results: Found[] };
    },
  });

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Find a payment</h1>
        <p className={`mt-1 text-sm ${MUTED}`}>Paste an order number, a UTR, an amount or the customer&rsquo;s phone number.</p>
      </div>
      <PortalSearchBox base={base} initial={q} autoFocus={!q} />

      {found.isLoading && <div className="h-32 animate-pulse rounded-2xl bg-[color:var(--color-surface)]" />}
      {found.isError && <p className="text-sm text-[color:var(--color-danger)]">Search failed: {found.error.message}</p>}

      {found.data && (
        found.data.results.length === 0 ? (
          <div className="flex flex-col items-center rounded-2xl border bg-[color:var(--color-surface)] px-6 py-10 text-center">
            <SearchX className={`h-8 w-8 ${MUTED}`} />
            <p className="mt-3 font-medium">Nothing found for &ldquo;{q}&rdquo;</p>
            <p className={`mt-1 max-w-sm text-sm ${MUTED}`}>
              We looked for it as {found.data.kinds.map((k) => KIND_WORDS[k] ?? k).join(" and as ")}. Amounts and UTRs are searched over the last 3 days.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {found.data.results.map((r) => (
              <li key={r.id} className="rounded-2xl border bg-[color:var(--color-surface)] p-4 shadow-sm sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]">
                      {r.kind === "order" ? <Receipt className="h-5 w-5" /> : <Banknote className="h-5 w-5" />}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{r.kind === "order" ? `Order ${r.txnid}` : "Money received"}</div>
                      <div className={`text-xs ${MUTED}`}>
                        {istTime(r.at)}{r.account ? `, ${r.account}` : ""}{r.livemode ? "" : ", test"}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-semibold tabular-nums">{rupees(r.amount)}</div>
                    <StatusPill status={r.status} />
                  </div>
                </div>
                <ol className="mt-4 space-y-1.5 border-l-2 border-[color:var(--color-border-strong)] pl-4">
                  {r.story.map((s, i) => <li key={i} className="text-[15px] leading-relaxed">{s}</li>)}
                </ol>
                {r.kind === "order" && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {r.txnid && <PaidButton txnid={r.txnid} status={r.raw_status} />}
                    <Link href={`${base}/orders/KTN_${r.id.replace(/-/g, "")}`} className="inline-flex min-h-9 items-center rounded-lg border px-3 text-sm font-medium hover:border-[color:var(--color-brand)]">
                      Full details
                    </Link>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
