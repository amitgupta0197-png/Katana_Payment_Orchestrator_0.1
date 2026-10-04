"use client";

// Master list (/mdm/{type}): records 25 a page from the server, search, and a column chooser
// (core summary + custom fields) remembered per browser. Staff only.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Columns3, Layers, Search } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { CORE, MASTERS, activeCustomFields, customFields, defaultColumns, type MasterType } from "@/lib/mdm";
import type { ListedRecord, RecordList } from "@/lib/mdm-store";
import { TYPE_ICON, fmtValue, muted, readJson, slug } from "./shared";

const storeKey = (t: MasterType) => `mdm.columns.${t}`;
function loadCols(t: MasterType): string[] | null {
  try { const v = JSON.parse(window.localStorage.getItem(storeKey(t)) ?? "null"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : null; }
  catch { return null; }
}
function saveCols(t: MasterType, cols: string[]) {
  try { window.localStorage.setItem(storeKey(t), JSON.stringify(cols)); } catch { /* storage unavailable: the choice lasts this visit */ }
}

export function MasterList({ type }: { type: MasterType }) {
  const m = MASTERS[type];
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [cols, setCols] = useState<string[] | null>(null);
  const [chooser, setChooser] = useState(false);

  useEffect(() => { const t = setTimeout(() => { setQ(text.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [text]);
  useEffect(() => { setCols(loadCols(type)); }, [type]);

  const list = useQuery({
    queryKey: ["mdm", "list", type, page, q],
    queryFn: async () => readJson<RecordList>(await fetch(`/api/mdm/${slug(type)}?page=${page}&q=${encodeURIComponent(q)}`)),
    placeholderData: keepPreviousData,
  });
  const fields = list.data?.fields ?? CORE[type];
  const custom = customFields(fields);
  const available = useMemo(() => [...m.summary, ...custom.map((f) => f.key)], [m.summary, custom]);
  const shown = (cols ?? defaultColumns(type, fields)).filter((k) => available.includes(k));
  const relLabels = Object.keys(list.data?.rows[0]?.relations ?? {});

  const toggle = (k: string) => {
    const next = shown.includes(k) ? shown.filter((x) => x !== k) : available.filter((x) => x === k || shown.includes(x));
    setCols(next); saveCols(type, next);
  };

  const columns: Column<ListedRecord>[] = [
    ...shown.map((k): Column<ListedRecord> => {
      const f = fields.find((x) => x.key === k);
      const isCore = !!f?.core;
      return {
        key: k, header: <span className="inline-flex items-center gap-1">{f?.label ?? k}{!isCore && <Badge variant="info" className="px-1 py-0 text-[10px]">custom</Badge>}</span>,
        render: (r) => {
          const v = isCore ? r.core[k] : r.extra[k];
          return k === m.summary[0] ? <span className="font-medium">{fmtValue(v)}</span> : <span className={f?.retired ? muted : ""}>{fmtValue(v)}</span>;
        },
      };
    }),
    ...relLabels.map((l): Column<ListedRecord> => ({ key: `rel:${l}`, header: l, className: "text-right tabular-nums", render: (r) => r.relations[l] ?? 0 })),
  ];

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / (list.data?.page_size ?? 25)));
  const Icon = TYPE_ICON[type];

  return (
    <div>
      <PageHeader title={m.plural} icon={Icon} description={m.description}
        actions={<>
          <Button asChild variant="secondary"><Link href={`/mdm/templates?type=${slug(type)}`}><Layers className="h-4 w-4" /> Template</Link></Button>
          <Button asChild variant="ghost"><Link href="/mdm">Master data</Link></Button>
        </>} />
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className={`pointer-events-none absolute left-3 top-2.5 h-4 w-4 ${muted}`} />
              <Input className="pl-9" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Search ${m.search.join(", ").replace(/_/g, " ")} or ID`} aria-label="Search" />
            </div>
            <div className="relative">
              <Button variant="secondary" onClick={() => setChooser((v) => !v)} aria-expanded={chooser}><Columns3 className="h-4 w-4" /> Columns</Button>
              {chooser && (
                <div className="absolute right-0 z-20 mt-2 w-64 rounded-lg border bg-[color:var(--color-surface)] p-3 shadow-lg">
                  <div className={`mb-2 text-xs ${muted}`}>Core</div>
                  {m.summary.map((k) => (
                    <label key={k} className="flex items-center gap-2 py-0.5 text-sm"><input type="checkbox" checked={shown.includes(k)} onChange={() => toggle(k)} />{fields.find((f) => f.key === k)?.label ?? k}</label>
                  ))}
                  <div className={`mb-2 mt-3 text-xs ${muted}`}>Custom</div>
                  {custom.length ? custom.map((f) => (
                    <label key={f.key} className="flex items-center gap-2 py-0.5 text-sm"><input type="checkbox" checked={shown.includes(f.key)} onChange={() => toggle(f.key)} />{f.label}{f.retired && <span className={`text-xs ${muted}`}>(retired)</span>}</label>
                  )) : <p className={`text-xs ${muted}`}>None yet.</p>}
                  <Button size="sm" variant="ghost" className="mt-2 w-full" onClick={() => { setCols(null); saveCols(type, defaultColumns(type, fields)); }}>Reset</Button>
                </div>
              )}
            </div>
          </div>
          {list.error ? <p className="text-sm text-[color:var(--color-danger)]">{(list.error as Error).message}</p> : (
            <DataTable columns={columns} rows={list.data?.rows ?? []} loading={list.isLoading} rowKey={(r) => r.id}
              onRowClick={(r) => router.push(`/mdm/${slug(type)}/${r.id}`)}
              emptyState={q ? "Nothing matches that search." : `No ${m.plural.toLowerCase()} yet.`} />
          )}
          <div className="flex items-center justify-between text-sm">
            <span className={muted}>{total} record{total === 1 ? "" : "s"}{activeCustomFields(fields).length ? ` · ${activeCustomFields(fields).length} custom fields` : ""}</span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
              <span className="tabular-nums">{page} / {pages}</span>
              <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
