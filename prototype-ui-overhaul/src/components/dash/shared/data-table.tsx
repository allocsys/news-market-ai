"use client";

import { cn } from "@/lib/utils";
import { Download, FileJson, FileSpreadsheet } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  rawValue?: (row: T) => string | number | null | undefined;
  className?: string;
  mobileFullWidth?: boolean;
  hideOnMobile?: boolean;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  filename: string;
  emptyState?: ReactNode;
  className?: string;
}

export function DataTable<T extends { id: string }>({
  columns,
  rows,
  filename,
  emptyState,
  className,
}: DataTableProps<T>) {
  function exportCSV() {
    const header = columns.map((c) => `"${c.header}"`).join(",");
    const body = rows
      .map((r) =>
        columns
          .map((c) => {
            const v = c.rawValue ? c.rawValue(r) : "";
            if (v == null) return "";
            const s = String(v).replace(/"/g, '""');
            return `"${s}"`;
          })
          .join(",")
      )
      .join("\n");
    download(`${filename}.csv`, `${header}\n${body}`, "text/csv");
  }

  function exportJSON() {
    const body = rows.map((r) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((c) => {
        obj[c.key] = c.rawValue ? c.rawValue(r) : null;
      });
      return obj;
    });
    download(`${filename}.json`, JSON.stringify(body, null, 2), "application/json");
  }

  if (rows.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
              <Download className="size-3.5" />
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={exportCSV} className="gap-2 text-xs">
              <FileSpreadsheet className="size-3.5" />
              CSV (.csv)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={exportJSON} className="gap-2 text-xs">
              <FileJson className="size-3.5" />
              JSON (.json)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Desktop / tablet: real table */}
      <div className="hidden md:block overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={cn("px-3 py-2.5 text-left font-medium whitespace-nowrap", c.className)}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className={cn("border-t border-border/60", i % 2 === 1 && "bg-muted/10")}>
                {columns.map((c) => (
                  <td key={c.key} className={cn("px-3 py-2.5 align-top", c.className)}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: stacked-card transformation (mirrors the repo's data-label pattern) */}
      <div className="md:hidden space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="rounded-xl border border-border bg-card p-3 grid grid-cols-2 gap-x-3 gap-y-2">
            {columns.map((c) => (
              <div
                key={c.key}
                className={cn(
                  "min-w-0",
                  c.mobileFullWidth && "col-span-2",
                  c.hideOnMobile && "hidden"
                )}
              >
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
                  {c.header}
                </div>
                <div className={cn("text-sm", c.className)}>{c.cell(r)}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function download(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
