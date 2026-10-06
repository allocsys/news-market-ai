"use client";

import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { NAV_SECTIONS } from "@/lib/nav";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";

export function MoreSheet({
  open,
  onOpenChange,
  activeSection,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  activeSection: string;
  onNavigate: (id: string) => void;
}) {
  const systemSections = NAV_SECTIONS.filter((s) => s.group === "system");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl pb-safe">
        <SheetHeader className="text-left">
          <SheetTitle className="font-display text-lg">More</SheetTitle>
          <SheetDescription>
            System operations: backtests, backfills, ingestion health, and pause switches.
          </SheetDescription>
        </SheetHeader>
        <ul className="mt-4 space-y-1">
          {systemSections.map((s) => {
            const Icon = s.icon;
            const active = activeSection === s.id;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => {
                    onNavigate(s.id);
                    onOpenChange(false);
                  }}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-3 text-left transition-colors hover:bg-accent/40",
                    active && "ring-2 ring-primary",
                  )}
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                    <Icon className="h-4 w-4 text-muted-foreground group-hover:text-foreground" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{s.label}</p>
                    <p className="truncate text-xs text-muted-foreground">{s.description}</p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </SheetContent>
    </Sheet>
  );
}
