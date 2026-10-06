"use client";

import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";
import { NAV_SECTIONS } from "@/lib/nav";
import { SectionHeading } from "../primitives";
import type { ViewProps } from "./types";

export function MoreView({ onNavigate }: ViewProps) {
  const groups: { id: string; label: string; description: string; sections: typeof NAV_SECTIONS }[] = [
    {
      id: "operate",
      label: "Operate",
      description: "Kill switches and live ticker selection",
      sections: NAV_SECTIONS.filter((s) => s.id === "controls"),
    },
    {
      id: "backtest",
      label: "Backtest & data",
      description: "Run backtests, backfill history, check ingestion",
      sections: NAV_SECTIONS.filter((s) => ["backtest", "backfill", "health"].includes(s.id)),
    },
  ];

  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g.id}>
          <SectionHeading title={g.label} description={g.description} />
          <ul className="mt-3 space-y-2">
            {g.sections.map((s) => {
              const Icon = s.icon;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onNavigate(s.id)}
                    className="group flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/40 card-hairline"
                  >
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                      <Icon className="h-4 w-4 text-muted-foreground group-hover:text-foreground" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{s.label}</p>
                      <p className="truncate text-xs text-muted-foreground">{s.description}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
