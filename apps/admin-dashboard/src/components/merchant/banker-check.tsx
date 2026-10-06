"use client";

// "Check this banker" (lib/banker-check): runs every check a live order meets on this banker and
// says, in plain words, what would stop one and how to fix it. Changes nothing.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ListChecks, Loader2, XCircle, AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { BankerCheckResult, CheckItem } from "@/lib/banker-check";

const muted = "text-[color:var(--color-text-muted)]";

export function useBankerCheck(merchantId: string, enabled = true) {
  return useQuery({
    queryKey: ["merchant", merchantId, "check"],
    enabled,
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/check`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d as BankerCheckResult & { checked_at: string };
    },
  });
}

function Fix({ item, onOpenTab, close }: { item: CheckItem; onOpenTab: (t: string) => void; close: () => void }) {
  if (!item.fix) return null;
  if (item.fix.href) return <Button asChild size="sm" variant="secondary"><Link href={item.fix.href}>{item.fix.label}</Link></Button>;
  return <Button size="sm" variant="secondary" onClick={() => { close(); onOpenTab(item.fix!.tab ?? "overview"); }}>{item.fix.label}</Button>;
}

export function BankerCheckResultView({ data, onOpenTab, close }: { data: BankerCheckResult & { checked_at?: string }; onOpenTab: (t: string) => void; close: () => void }) {
  return (
    <div className="space-y-3">
      {data.blockers.length > 0 && (
        <div className={`flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider ${muted}`}>Stops a live order
          <InfoTip label="what stops a live order">Each red item makes Katana refuse a real order. Fix it with the button under it, then check again.</InfoTip>
        </div>
      )}
      {data.blockers.map((b) => (
        <div key={b.key} className="rounded-lg border border-[color:var(--color-danger)]/35 bg-[color:var(--color-danger-muted)] p-3">
          <div className="flex items-start gap-2.5">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-danger)]" aria-hidden />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="text-sm font-semibold">{b.title}</div>
              <div className={`text-sm ${muted}`}>{b.detail}</div>
              <div className="pt-1"><Fix item={b} onOpenTab={onOpenTab} close={close} /></div>
            </div>
          </div>
        </div>
      ))}
      {data.notes.length > 0 && (
        <div className={`flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider ${muted}`}>Good to know
          <InfoTip label="good to know">These do not stop orders. They are limits or open tasks the merchant should know about.</InfoTip>
        </div>
      )}
      {data.notes.map((n) => (
        <div key={n.key} className="rounded-lg border border-[color:var(--color-warning)]/35 bg-[color:var(--color-warning-muted)] p-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-warning)]" aria-hidden />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="text-sm font-medium">{n.title}</div>
              <div className={`text-sm ${muted}`}>{n.detail}</div>
              {n.fix && <div className="pt-1"><Fix item={n} onOpenTab={onOpenTab} close={close} /></div>}
            </div>
          </div>
        </div>
      ))}
      <div className="overflow-hidden rounded-lg border">
        <div className={`flex items-center gap-1.5 border-b px-3 py-2 text-[11px] font-medium uppercase tracking-wider ${muted}`}>Passed · {data.passed.length}
          <InfoTip label="passed checks">These checks are fine. A real order gets past each of them today.</InfoTip>
        </div>
        <ul>
          {data.passed.map((p) => (
            <li key={p.key} className="flex items-center gap-2.5 border-b px-3 py-2 text-sm last:border-b-0">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-[color:var(--color-success)]" aria-hidden />
              <span className="font-medium">{p.title}</span>
              <span className={`ml-auto truncate text-right ${muted}`} title={p.detail}>{p.detail}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className={`text-xs ${muted}`}>The check makes no payment and changes nothing. Run it again any time.</p>
    </div>
  );
}

/** The header button and its result. */
export function BankerCheckButton({ merchantId, onOpenTab }: { merchantId: string; onOpenTab: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const q = useBankerCheck(merchantId, open);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => { setOpen(true); if (q.data) q.refetch(); }}>
        <ListChecks className="h-4 w-4" /> Check this banker
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{q.data ? q.data.headline : "Checking…"}</DialogTitle>
            <DialogDescription>
              {q.data
                ? q.data.ready
                  ? "Every check a real order goes through passed."
                  : `We ran every check a real order goes through. ${q.data.blockers.length === 1 ? "One thing stops it." : `${q.data.blockers.length} things stop it.`}`
                : "Running every check a real order goes through."}
            </DialogDescription>
          </DialogHeader>
          {q.isLoading || q.isFetching && !q.data
            ? <div className={`flex items-center gap-2 py-6 text-sm ${muted}`}><Loader2 className="h-4 w-4 animate-spin" /> Checking…</div>
            : q.error
              ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>
              : q.data && <BankerCheckResultView data={q.data} onOpenTab={onOpenTab} close={() => setOpen(false)} />}
          {q.data && (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => q.refetch()} disabled={q.isFetching}>
                <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} /> Run again
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
