"use client";

// World-class list shell. Every list page in the app composes this:
//   <DataView rows={...} columns={...} search={...} filters={...} bulkActions={...} fab={...} />
//
// Built-in:
//  - Typeahead search (debounced, multi-field)
//  - Filter chips (toggleable predicates)
//  - View-mode toggle (table | card | kanban — opt-in)
//  - Sort + density + column-visibility menus
//  - Multi-select w/ BulkBar
//  - Empty / loading states
//  - URL-encoded filter state (so views are shareable)
//  - Saved views (localStorage; per-module key)

import * as React from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  Search, SlidersHorizontal, LayoutGrid, List as ListIcon, Columns3, Bookmark,
  ChevronDown, RefreshCw,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { BulkBar, type BulkAction } from "./bulk-bar";
import { EmptyState } from "./empty-state";
import { cn } from "@/lib/utils";
import type { Column } from "@/components/ui/data-table";

export type Density = "compact" | "default" | "comfortable";
export type ViewMode = "table" | "card" | "kanban";

export interface FilterDef<T> {
  key: string;
  label: string;
  predicate: (row: T) => boolean;
}

interface DataViewProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  loading?: boolean;
  search?: { placeholder?: string; fields: (keyof T | ((row: T) => string))[] };
  filters?: FilterDef<T>[];
  defaultFilter?: string | null;
  bulkActions?: BulkAction[];
  rowActions?: (row: T) => React.ReactNode;
  href?: (row: T) => string;
  renderCard?: (row: T, selected: boolean, onSelect: () => void) => React.ReactNode;
  kanbanColumn?: (row: T) => string;
  kanbanColumns?: { key: string; label: string }[];
  fab?: { label: string; onClick: () => void; icon?: React.ComponentType<{ className?: string }> };
  refresh?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  savedViewKey?: string;
  modes?: ViewMode[];
}

interface SavedView {
  name: string;
  search: string;
  filter: string | null;
  density: Density;
  mode: ViewMode;
  hidden: string[];
}

export function DataView<T>({
  rows, columns, rowKey, loading,
  search, filters = [], defaultFilter = null,
  bulkActions = [], rowActions, href,
  renderCard, kanbanColumn, kanbanColumns,
  fab, refresh,
  emptyTitle = "No records yet",
  emptyDescription,
  savedViewKey,
  modes = ["table"],
}: DataViewProps<T>) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const [q, setQ] = React.useState(sp.get("q") ?? "");
  const [filter, setFilter] = React.useState<string | null>(sp.get("f") ?? defaultFilter);
  const [density, setDensity] = React.useState<Density>((sp.get("d") as Density) ?? "default");
  const [mode, setMode] = React.useState<ViewMode>((sp.get("m") as ViewMode) ?? modes[0] ?? "table");
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  // Persist filter state in URL — shareable, back-button friendly.
  React.useEffect(() => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (filter) params.set("f", filter);
    if (density !== "default") params.set("d", density);
    if (mode !== (modes[0] ?? "table")) params.set("m", mode);
    const next = params.toString();
    const current = sp.toString();
    if (next !== current) router.replace(`${pathname}${next ? `?${next}` : ""}`, { scroll: false });
  }, [q, filter, density, mode, pathname, router, modes, sp]);

  const searchFields = search?.fields;
  const ql = q.trim().toLowerCase();

  const filtered = React.useMemo(() => {
    let out = rows;
    if (filter) {
      const f = filters.find((x) => x.key === filter);
      if (f) out = out.filter(f.predicate);
    }
    if (ql && searchFields) {
      out = out.filter((row) =>
        searchFields.some((field) => {
          const v = typeof field === "function" ? field(row) : String((row as Record<string, unknown>)[field as string] ?? "");
          return v.toLowerCase().includes(ql);
        }),
      );
    }
    return out;
  }, [rows, filter, ql, filters, searchFields]);

  const visibleCols = columns.filter((c) => !hidden.has(c.key));
  const selectedRows = filtered.filter((r) => selected.has(rowKey(r)));
  const allFilteredSelected = filtered.length > 0 && filtered.every((r) => selected.has(rowKey(r)));

  const toggleRow = (k: string) =>
    setSelected((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleAllFiltered = () =>
    setSelected((s) => {
      const n = new Set(s);
      if (allFilteredSelected) filtered.forEach((r) => n.delete(rowKey(r)));
      else filtered.forEach((r) => n.add(rowKey(r)));
      return n;
    });

  // Saved views (localStorage).
  const [savedViews, setSavedViews] = React.useState<SavedView[]>([]);
  React.useEffect(() => {
    if (!savedViewKey) return;
    try {
      const raw = localStorage.getItem(`dv:${savedViewKey}`);
      if (raw) setSavedViews(JSON.parse(raw));
    } catch { /* ignore */ }
  }, [savedViewKey]);
  const saveCurrentView = () => {
    if (!savedViewKey) return;
    const name = prompt("Name this view");
    if (!name) return;
    const view: SavedView = { name, search: q, filter, density, mode, hidden: [...hidden] };
    const next = [...savedViews.filter((v) => v.name !== name), view];
    setSavedViews(next);
    try { localStorage.setItem(`dv:${savedViewKey}`, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const applyView = (v: SavedView) => {
    setQ(v.search); setFilter(v.filter); setDensity(v.density);
    setMode(v.mode); setHidden(new Set(v.hidden));
  };

  const densityPad = density === "compact" ? "py-1.5" : density === "comfortable" ? "py-4" : "py-3";

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {search && (
          <div className="relative flex-1 min-w-[12rem] max-w-md">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--color-text-muted)]" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={search.placeholder ?? "Search…"}
              className="pl-8"
            />
          </div>
        )}
        {filters.length > 0 && (
          <div className="flex min-w-0 max-w-full items-center gap-1 overflow-x-auto">
            {filters.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(filter === f.key ? null : f.key)}
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1 text-xs transition-colors",
                  filter === f.key
                    ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]"
                    : "border-[color:var(--color-border)] text-[color:var(--color-text-muted)] hover:bg-[color:var(--color-surface-muted)]",
                )}
              >
                {f.label}
              </button>
            ))}
            {filter && (
              <button
                onClick={() => setFilter(null)}
                className="ml-1 text-xs text-[color:var(--color-text-muted)] hover:underline"
              >
                Clear
              </button>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          {refresh && (
            <Button variant="secondary" size="sm" className="h-8 w-8 p-0" onClick={refresh} aria-label="Refresh">
              <RefreshCw className="h-4 w-4" />
            </Button>
          )}
          {modes.length > 1 && (
            <div className="flex items-center rounded-md border border-[color:var(--color-border)] p-0.5">
              {modes.includes("table") && (
                <button
                  className={cn("flex h-7 w-7 items-center justify-center rounded", mode === "table" ? "bg-[color:var(--color-surface-muted)]" : "")}
                  onClick={() => setMode("table")}
                  aria-label="Table view"
                ><ListIcon className="h-3.5 w-3.5" /></button>
              )}
              {modes.includes("card") && (
                <button
                  className={cn("flex h-7 w-7 items-center justify-center rounded", mode === "card" ? "bg-[color:var(--color-surface-muted)]" : "")}
                  onClick={() => setMode("card")}
                  aria-label="Card view"
                ><LayoutGrid className="h-3.5 w-3.5" /></button>
              )}
              {modes.includes("kanban") && kanbanColumn && (
                <button
                  className={cn("flex h-7 w-7 items-center justify-center rounded", mode === "kanban" ? "bg-[color:var(--color-surface-muted)]" : "")}
                  onClick={() => setMode("kanban")}
                  aria-label="Kanban view"
                ><Columns3 className="h-3.5 w-3.5" /></button>
              )}
            </div>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="sm" className="h-8">
                <SlidersHorizontal className="h-3.5 w-3.5" /> View <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Density</DropdownMenuLabel>
              {(["compact", "default", "comfortable"] as Density[]).map((d) => (
                <DropdownMenuItem key={d} onSelect={(e) => { e.preventDefault(); setDensity(d); }}>
                  <span className={density === d ? "font-medium" : ""}>{d}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Columns</DropdownMenuLabel>
              {columns.map((c) => (
                <DropdownMenuItem
                  key={c.key}
                  onSelect={(e) => {
                    e.preventDefault();
                    setHidden((h) => { const n = new Set(h); n.has(c.key) ? n.delete(c.key) : n.add(c.key); return n; });
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!hidden.has(c.key)}
                    onChange={() => {}}
                    className="h-3.5 w-3.5 accent-[color:var(--color-brand)]"
                  />
                  <span>{typeof c.header === "string" ? c.header : c.key}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {savedViewKey && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm" className="h-8">
                  <Bookmark className="h-3.5 w-3.5" /> Views <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={(e) => { e.preventDefault(); saveCurrentView(); }}>
                  Save current view…
                </DropdownMenuItem>
                {savedViews.length > 0 && <DropdownMenuSeparator />}
                {savedViews.map((v) => (
                  <DropdownMenuItem key={v.name} onSelect={(e) => { e.preventDefault(); applyView(v); }}>
                    {v.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {fab && (
            <Button onClick={fab.onClick} size="sm">
              {fab.icon ? <fab.icon className="h-4 w-4" /> : null} {fab.label}
            </Button>
          )}
        </div>
      </div>

      {/* Status line */}
      <div className="flex items-center gap-2 text-xs text-[color:var(--color-text-muted)]">
        <span>{filtered.length} of {rows.length}</span>
        {filter && <Badge variant="info">filter: {filter}</Badge>}
        {q && <Badge variant="info">search: “{q}”</Badge>}
      </div>

      {/* Body */}
      {loading ? (
        <div className="rounded-lg border bg-[color:var(--color-surface)] p-8 text-center text-sm text-[color:var(--color-text-muted)]">
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={emptyTitle}
          description={emptyDescription ?? (rows.length === 0 ? "Get started by creating one." : "Try clearing filters.")}
          action={fab && rows.length === 0 ? { label: fab.label, onClick: fab.onClick, icon: fab.icon } : undefined}
        />
      ) : mode === "card" && renderCard ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((row) => {
            const k = rowKey(row);
            return <React.Fragment key={k}>{renderCard(row, selected.has(k), () => toggleRow(k))}</React.Fragment>;
          })}
        </div>
      ) : mode === "kanban" && kanbanColumn && kanbanColumns ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {kanbanColumns.map((col) => {
            const colRows = filtered.filter((r) => kanbanColumn(r) === col.key);
            return (
              <div key={col.key} className="flex flex-col gap-2 rounded-md border bg-[color:var(--color-surface-muted)]/40 p-2">
                <div className="flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">
                  <span>{col.label}</span>
                  <span>{colRows.length}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {colRows.map((row) => {
                    const k = rowKey(row);
                    return renderCard
                      ? <React.Fragment key={k}>{renderCard(row, selected.has(k), () => toggleRow(k))}</React.Fragment>
                      : (
                        <div key={k} className="rounded-md border bg-[color:var(--color-surface)] p-2 text-sm">
                          {visibleCols[0]?.render?.(row) ?? String((row as Record<string, unknown>)[visibleCols[0]?.key] ?? "")}
                        </div>
                      );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-[color:var(--color-surface)]">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-[color:var(--color-surface-muted)] text-xs font-medium uppercase tracking-wide text-[color:var(--color-text-muted)]">
              <tr>
                {bulkActions.length > 0 && (
                  <th className="w-10 px-3">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleAllFiltered}
                      className="h-4 w-4 accent-[color:var(--color-brand)]"
                      aria-label="Select all"
                    />
                  </th>
                )}
                {visibleCols.map((c) => (
                  <th key={c.key} className={cn("px-4 py-3 border-b", c.className)} style={c.width ? { width: c.width } : undefined}>
                    {c.header}
                  </th>
                ))}
                {rowActions && <th className="w-12 px-3" />}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const k = rowKey(row);
                const isSel = selected.has(k);
                return (
                  <tr
                    key={k}
                    className={cn(
                      "border-b last:border-0 hover:bg-[color:var(--color-surface-muted)]",
                      isSel && "bg-[color:var(--color-brand-muted)]/40",
                      href && "cursor-pointer",
                    )}
                    onClick={href ? () => router.push(href(row)) : undefined}
                  >
                    {bulkActions.length > 0 && (
                      <td className="px-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => toggleRow(k)}
                          className="h-4 w-4 accent-[color:var(--color-brand)]"
                          aria-label={`Select row ${k}`}
                        />
                      </td>
                    )}
                    {visibleCols.map((c) => (
                      <td key={c.key} className={cn("px-4 align-middle text-[color:var(--color-text)]", densityPad, c.className)}>
                        {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "")}
                      </td>
                    ))}
                    {rowActions && (
                      <td className="px-2 text-right" onClick={(e) => e.stopPropagation()}>
                        {rowActions(row)}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Bulk action bar */}
      <BulkBar
        count={selectedRows.length}
        total={filtered.length}
        onClear={() => setSelected(new Set())}
        onSelectAll={() => setSelected(new Set(filtered.map(rowKey)))}
        actions={bulkActions.map((a) => ({ ...a, onClick: () => { a.onClick(); /* caller decides whether to clear */ } }))}
      />
    </div>
  );
}
