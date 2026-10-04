"use client";

// One actor's checklist (GET /api/health-checks/{type}/{id}: computed now), each item with its
// state, what to do and where, and what was completed when. Staff screens only.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, XCircle, OctagonAlert, ArrowRight, History } from "lucide-react";
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import { Ring, BAND_VARIANT, type HealthActorType, type HealthBand } from "@/components/health/health-ring";

interface Item { key: string; label: string; state: "DONE" | "MISSING" | "OPTIONAL_MISSING"; critical: boolean; action?: string; href?: string; evidence?: string }
interface Detail {
  health: { type: HealthActorType; id: string; label: string; live: boolean; score: number; raw_score: number; band: HealthBand; items: Item[] };
  completions: { item_key: string; completed_at: string; completed_by: string; method: string; evidence_ref: string | null }[];
  computed_at: string;
}

const TYPE_WORD: Record<HealthActorType, string> = { TSP: "TSP", BANKER: "Banker", MERCHANT: "Merchant", INTEGRATION: "Integration" };

export function ChecklistDrawer({ type, id, label, open, onOpenChange }: {
  type: HealthActorType; id: string; label: string; open: boolean; onOpenChange: (o: boolean) => void;
}) {
  const q = useQuery({
    queryKey: ["health-check", type, id],
    enabled: open,
    queryFn: async () => {
      const r = await fetch(`/api/health-checks/${type}/${encodeURIComponent(id)}`);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      return d as Detail;
    },
  });
  const h = q.data?.health;
  const items = h?.items ?? [];
  const order = (i: Item) => (i.state === "MISSING" ? (i.critical ? 0 : 1) : i.state === "OPTIONAL_MISSING" ? 2 : 3);
  const sorted = [...items].sort((a, b) => order(a) - order(b));
  const labelOf = new Map(items.map((i) => [i.key, i.label]));

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent size="md" onClick={(e) => e.stopPropagation()}>
        <DrawerHeader>
          <div className="flex items-center gap-3 pr-8">
            <Ring score={h?.score} band={h?.band} size={44} />
            <div className="min-w-0">
              <DrawerTitle className="truncate">{label}</DrawerTitle>
              <DrawerDescription>
                {TYPE_WORD[type]} health{h ? ` · ${h.live ? "live" : "not live"}` : ""}
                {h?.band === "BLOCKED" ? ` · would be ${h.raw_score} without the blocking item` : ""}
              </DrawerDescription>
            </div>
            {h && <Badge variant={BAND_VARIANT[h.band]} className="ml-auto">{h.band}</Badge>}
          </div>
        </DrawerHeader>
        <DrawerBody className="space-y-5">
          {q.isLoading && <div className="py-8 text-center text-sm text-[color:var(--color-text-muted)]">Checking…</div>}
          {q.isError && <div className="rounded-md border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger-muted)] p-3 text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</div>}
          {h && (
            <ul className="space-y-2">
              {sorted.map((i) => (
                <li key={i.key} className="flex items-start gap-3 rounded-md border border-[color:var(--color-border)] px-3 py-2.5">
                  <ItemIcon item={i} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      {i.label}
                      {i.critical && i.state === "MISSING" && <Badge variant="danger" className="text-[10px]">blocking</Badge>}
                      {i.state === "OPTIONAL_MISSING" && <Badge variant="default" className="text-[10px]">optional</Badge>}
                    </div>
                    {i.state !== "DONE" && i.action && <div className="mt-0.5 text-xs text-[color:var(--color-text-muted)]">{i.action}</div>}
                    {i.state === "DONE" && i.evidence && <div className="mt-0.5 truncate text-xs text-[color:var(--color-text-subtle)]">{i.evidence}</div>}
                  </div>
                  {i.state !== "DONE" && i.href && (
                    <Link href={i.href} onClick={() => onOpenChange(false)}
                      className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-[color:var(--color-brand)] hover:underline">
                      Fix <ArrowRight className="h-3 w-3" />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
          {q.data && (
            <section>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
                <History className="h-3.5 w-3.5" /> Completed
              </h3>
              {q.data.completions.length === 0
                ? <p className="text-xs text-[color:var(--color-text-muted)]">Nothing recorded yet. An item is recorded when a check sees it turn done.</p>
                : (
                  <ol className="space-y-1.5 text-xs">
                    {q.data.completions.map((c, n) => (
                      <li key={n} className="flex items-baseline gap-2">
                        <span className="w-32 shrink-0 text-[color:var(--color-text-muted)]">{formatDateTime(c.completed_at)}</span>
                        <span className="font-medium">{labelOf.get(c.item_key) ?? c.item_key}</span>
                        <span className="truncate text-[color:var(--color-text-subtle)]">{c.method === "SYSTEM_AUTO" ? "seen by the system" : `${c.method.toLowerCase()} · ${c.completed_by}`}{c.evidence_ref ? ` · ${c.evidence_ref}` : ""}</span>
                      </li>
                    ))}
                  </ol>
                )}
              <p className="mt-3 text-[10px] text-[color:var(--color-text-subtle)]">Checked {formatDateTime(q.data.computed_at)}</p>
            </section>
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

function ItemIcon({ item }: { item: Item }) {
  const cls = "mt-0.5 h-4 w-4 shrink-0";
  if (item.state === "DONE") return <CheckCircle2 className={cls} style={{ color: "var(--color-success)" }} />;
  if (item.state === "OPTIONAL_MISSING") return <Circle className={cls} style={{ color: "var(--color-text-subtle)" }} />;
  if (item.critical) return <OctagonAlert className={cls} style={{ color: "var(--color-danger)" }} />;
  return <XCircle className={cls} style={{ color: "var(--color-warning)" }} />;
}
