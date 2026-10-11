"use client";

// On the "Pays UPI ID" tab: whether the phone online for this banker fits it — reads the QR's app,
// holds this banker's BharatPe key (lib/banker-check phoneMismatches, via "Check this banker").
// Shows nothing when all is well or the check isn't visible to this login.

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";

interface Item { key: string; title: string; detail: string }

export function PhoneFitBanner({ merchantId }: { merchantId: string }) {
  const q = useQuery({
    queryKey: ["merchant", merchantId, "check"],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/check`);
      if (!r.ok) return null;
      return (await r.json()) as { notes: Item[] };
    },
    refetchInterval: 60_000,
  });
  const items = (q.data?.notes ?? []).filter((n) => n.key === "PHONE_APP_MISMATCH" || n.key === "BHARATPE_KEY_MISMATCH" || n.key === "PHONE_OFFLINE");
  if (!items.length) return null;
  return (
    <div className="mb-4 space-y-2">
      {items.map((n) => (
        <div key={n.key} role="alert" className="flex gap-3 rounded-xl border border-[color:var(--color-warning)] bg-[color:var(--color-warning-muted)] px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-warning)]" />
          <div><div className="font-medium">{n.title}</div><div className="text-[color:var(--color-text-muted)]">{n.detail} Use <b>Pair the banker&apos;s phone</b> below.</div></div>
        </div>
      ))}
    </div>
  );
}
