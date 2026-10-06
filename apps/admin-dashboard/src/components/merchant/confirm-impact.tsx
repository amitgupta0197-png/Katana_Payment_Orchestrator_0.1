"use client";

// "Before you save" (lib/change-impact): ask the impact route what a risky change would do to a
// banker's orders and, when it would stop or move any, show it with a choice to keep things as
// they are. Nothing at stake: it goes ahead without asking. A failed lookup goes ahead too: the
// warning helps, it never blocks a save.

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Impact } from "@/lib/change-impact";

const muted = "text-[color:var(--color-text-muted)]";

export function useImpactConfirm() {
  const [impact, setImpact] = useState<Impact | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const ask = async (url: string): Promise<boolean> => {
    let d: Impact | null = null;
    try {
      const r = await fetch(url);
      if (r.ok) d = (await r.json()) as Impact;
    } catch { /* go ahead */ }
    if (!d || d.none) return true;
    setImpact(d);
    return new Promise<boolean>((resolve) => { resolver.current = resolve; });
  };
  const answer = (ok: boolean) => { resolver.current?.(ok); resolver.current = null; setImpact(null); };

  const dialog = (
    <Dialog open={!!impact} onOpenChange={(o) => { if (!o) answer(false); }}>
      <DialogContent className="sm:max-w-lg">
        {impact && <>
          <DialogHeader>
            <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[color:var(--color-warning)]">Before you save</div>
            <DialogTitle>{impact.title}</DialogTitle>
            <DialogDescription className="sr-only">What this change does to the orders this banker takes.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {impact.body.slice(0, 1).map((p, i) => <p key={i} className={muted}>{p}</p>)}
            {impact.rows.length > 0 && (
              <dl className="space-y-1.5 rounded-lg bg-[color:var(--color-surface-muted)] px-3.5 py-3">
                {impact.rows.map((r, i) => (
                  <div key={i} className="flex justify-between gap-3">
                    <dt>{r.label}</dt>
                    <dd className="font-mono tabular-nums">{r.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {impact.body.slice(1).map((p, i) => <p key={i} className={muted}>{p}</p>)}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="secondary" onClick={() => answer(false)}>{impact.keepLabel}</Button>
            <Button variant="danger" onClick={() => answer(true)}>{impact.proceedLabel}</Button>
          </DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
  );
  return { ask, dialog };
}
