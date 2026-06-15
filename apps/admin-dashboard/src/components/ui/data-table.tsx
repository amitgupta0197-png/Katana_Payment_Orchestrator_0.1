"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  render?: (row: T) => React.ReactNode;
  className?: string;
  width?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  emptyState?: React.ReactNode;
  rowKey?: (row: T, idx: number) => string;
  onRowClick?: (row: T) => void;
  className?: string;
}

export function DataTable<T>({
  columns, rows, loading, emptyState, rowKey, onRowClick, className,
}: DataTableProps<T>) {
  if (loading) {
    return (
      <div className="rounded-lg border bg-[color:var(--color-surface)] p-8 text-center text-sm text-[color:var(--color-text-muted)]">
        Loading…
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div className="rounded-lg border bg-[color:var(--color-surface)] p-8 text-center text-sm text-[color:var(--color-text-muted)]">
        {emptyState ?? "No records."}
      </div>
    );
  }
  return (
    <div className={cn("overflow-x-auto rounded-lg border bg-[color:var(--color-surface)]", className)}>
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-[color:var(--color-surface-muted)] text-xs font-medium uppercase tracking-wide text-[color:var(--color-text-muted)]">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn("px-4 py-3 border-b", c.className)}
                style={c.width ? { width: c.width } : undefined}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const key = rowKey ? rowKey(row, idx) : String(idx);
            return (
              <tr
                key={key}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  "border-b last:border-0 hover:bg-[color:var(--color-surface-muted)]",
                  onRowClick && "cursor-pointer",
                )}
              >
                {columns.map((c) => {
                  const v = c.render
                    ? c.render(row)
                    : (row as Record<string, unknown>)[c.key];
                  return (
                    <td key={c.key} className={cn("px-4 py-3 align-middle text-[color:var(--color-text)]", c.className)}>
                      {v as React.ReactNode}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
