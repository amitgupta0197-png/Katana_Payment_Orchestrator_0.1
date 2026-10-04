"use client";

// MDM Home: one card per master type (lib/mdm-store home). Staff only.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Database, Layers } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { HomeCard } from "@/lib/mdm-store";
import { TYPE_ICON, fmtTime, muted, readJson, slug } from "@/components/mdm/shared";

export default function MdmHomePage() {
  const q = useQuery({ queryKey: ["mdm", "home"], queryFn: async () => (await readJson<{ types: HomeCard[] }>(await fetch("/api/mdm"))).types });
  return (
    <div>
      <PageHeader title="Master data" icon={Database}
        description="Banks, TSPs, bankers, merchants and channels: their templates, custom fields and how they connect."
        actions={<Button asChild variant="secondary"><Link href="/mdm/templates"><Layers className="h-4 w-4" /> Template Manager</Link></Button>} />
      {q.error && <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>}
      {q.isLoading && <p className={`text-sm ${muted}`}>Loading…</p>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {(q.data ?? []).map((t) => {
          const Icon = TYPE_ICON[t.type];
          return (
            <Card key={t.type}>
              <CardContent className="space-y-4 pt-6">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]"><Icon className="h-5 w-5" /></span>
                    <div className="min-w-0">
                      <h2 className="font-semibold">{t.plural}</h2>
                      <p className={`text-xs ${muted}`}>{t.description}</p>
                    </div>
                  </div>
                  <Badge variant="brand">v{t.version}</Badge>
                </div>
                <dl className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg border p-2"><dt className={`text-xs ${muted}`}>Records</dt><dd className="text-lg font-semibold tabular-nums">{t.records ?? "—"}</dd></div>
                  <div className="rounded-lg border p-2"><dt className={`text-xs ${muted}`}>Core fields</dt><dd className="text-lg font-semibold tabular-nums">{t.core_fields}</dd></div>
                  <div className="rounded-lg border p-2"><dt className={`text-xs ${muted}`}>Custom fields</dt><dd className="text-lg font-semibold tabular-nums">{t.custom_fields}</dd></div>
                </dl>
                <div className={`flex flex-wrap items-center gap-2 text-xs ${muted}`}>
                  <span>Last change {fmtTime(t.last_change)}</span>
                  {t.retired_fields > 0 && <Badge>{t.retired_fields} retired</Badge>}
                  {t.with_values !== null && t.custom_fields > 0 && <span>· {t.with_values} with custom values</span>}
                  {t.pending_template && <Badge variant="warning">Change awaiting approval</Badge>}
                </div>
                <div className="flex gap-2">
                  <Button asChild size="sm"><Link href={`/mdm/${slug(t.type)}`}>Open {t.plural.toLowerCase()}</Link></Button>
                  <Button asChild size="sm" variant="secondary"><Link href={`/mdm/templates?type=${slug(t.type)}`}>Template</Link></Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
