"use client";

// The MID switch on the portal's Home: for each banker that has MIDs, what is taking traffic now
// on each rail, and a one-tap switch to another MID (until switched back) or back to automatic.
// The full controls are on the MID switch page. Shows nothing for a banker with no MIDs.

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";
import { MID_KIND_LABEL, type MidKind } from "@/lib/mid-switch";
import type { SwitchDetail } from "@/components/mid-switch/mid-switch-panel";

export function MidQuickSwitch({ base }: { base: string }) {
  const list = useQuery({
    queryKey: ["mid-switch-bankers"],
    queryFn: async () => (await fetch("/api/mid-switch").then((r) => r.json())) as { bankers: { banker: string; name: string; kinds: Record<MidKind, { total: number }> }[] },
  });
  const withMids = (list.data?.bankers ?? []).filter((b) => b.kinds.UPI.total + b.kinds.GATEWAY.total > 0).slice(0, 3);
  if (!withMids.length) return null;
  return (
    <section aria-labelledby="mid-quick" className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 id="mid-quick" className="flex items-center gap-2 text-base font-semibold"><ArrowRightLeft className="h-4 w-4" /> Traffic switch</h2>
        <Link href={`${base}/mid-switch`} className="text-sm font-medium text-[color:var(--color-brand)]">Limits and rules</Link>
      </div>
      <div className="space-y-3">{withMids.map((b) => <BankerRow key={b.banker} banker={b.banker} name={withMids.length > 1 ? b.name : null} />)}</div>
    </section>
  );
}

function BankerRow({ banker, name }: { banker: string; name: string | null }) {
  const qc = useQueryClient();
  const key = ["mid-switch", banker];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => (await fetch(`/api/mid-switch?banker=${encodeURIComponent(banker)}`).then((r) => r.json())) as SwitchDetail,
    refetchInterval: 30_000,
  });
  const act = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const r = await fetch("/api/mid-switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ banker, ...body }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d as SwitchDetail;
    },
    onSuccess: (d) => { qc.setQueryData(key, d); toast.success("Traffic switched"); },
    onError: (e: Error) => toast.error("Not switched", { description: e.message }),
  });
  const d = q.data;
  if (!d) return null;
  return (
    <div className="space-y-1.5">
      {name && <div className="text-xs font-medium text-[color:var(--color-text-muted)]">{name}</div>}
      {(["UPI", "GATEWAY"] as MidKind[]).filter((k) => d.mids.some((m) => m.kind === k)).map((k) => {
        const mids = d.mids.filter((m) => m.kind === k);
        const s = d.settings[k];
        const now = mids.find((m) => m.pinned) ?? mids.find((m) => m.last_used);
        const can = mids.filter((m) => m.takes_traffic_now).length;
        return (
          <div key={k} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-[11rem] text-[color:var(--color-text-muted)]">{MID_KIND_LABEL[k]}</span>
            <span className="font-medium">{s.enabled ? now?.name ?? "—" : "switch off"}</span>
            <span className={`text-xs ${can ? "text-[color:var(--color-text-muted)]" : "text-[color:var(--color-danger)]"}`}>{can} of {mids.length} can take payments</span>
            <select aria-label={`Switch ${MID_KIND_LABEL[k]}`} disabled={act.isPending || !s.enabled}
              value={s.pinned_mid_id ?? ""}
              onChange={(e) => act.mutate(e.target.value ? { action: "pin", kind: k, mid_id: e.target.value, reason: "switched from Home" } : { action: "unpin", kind: k })}
              className="ml-auto rounded-md border bg-[color:var(--color-surface)] px-2 py-1 text-sm">
              <option value="">Automatic ({s.mode === "WEIGHTED" ? "weighted split" : "priority"})</option>
              {mids.filter((m) => m.status === "ACTIVE").map((m) => <option key={m.id} value={m.id}>Send all to {m.name}</option>)}
            </select>
          </div>
        );
      })}
    </div>
  );
}
