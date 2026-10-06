"use client";

import { cn } from "@/lib/utils";
import { RefreshCw, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { fmtTime } from "@/lib/format";

// ============================================================
// Page toolbar — appears above each section
//
// "Loaded" is the time of the newest data in the query cache (not a mock
// clock), and Refresh refetches every active query. Views already poll every
// 30s on their own, so there is no separate auto-refresh switch; the old
// Auto/Export controls did nothing and were removed.
// ============================================================
export function PageToolbar({
  env,
  envAware,
  className,
}: {
  env: string;
  onEnvChange: (env: string) => void;
  envAware: boolean;
  className?: string;
}) {
  const qc = useQueryClient();
  const fetching = useIsFetching() > 0; // re-renders this component as fetches start/finish
  const updatedAt = qc
    .getQueryCache()
    .getAll()
    .map((q) => q.state.dataUpdatedAt)
    .filter((t) => t > 0);
  const lastLoaded = updatedAt.length > 0 ? new Date(Math.max(...updatedAt)).toISOString() : null;

  return (
    <div
      className={cn(
        "sticky top-14 z-20 flex flex-wrap items-center gap-2 border-b border-border bg-background/85 px-3 py-2 backdrop-blur md:top-0 md:px-6",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" aria-hidden />
        <span className="font-mono nums">Loaded {fmtTime(lastLoaded)}</span>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => qc.invalidateQueries()}
          disabled={fetching}
          className="h-8 gap-1.5"
        >
          <RefreshCw className={cn("h-3 w-3", fetching && "animate-spin")} />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>

      {envAware && <EnvPill env={env} />}
    </div>
  );
}

function EnvPill({ env }: { env: string }) {
  const isLive = env === "live";
  return (
    <div
      className={cn(
        "hidden items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium sm:flex md:ml-2",
        isLive
          ? "border-[color:var(--long)]/25 bg-[color:var(--long)]/8 text-[color:var(--long)]"
          : "border-[color:var(--info)]/25 bg-[color:var(--info)]/8 text-[color:var(--info)]",
      )}
    >
      {isLive ? "Live env" : "Backtest env"}
    </div>
  );
}
