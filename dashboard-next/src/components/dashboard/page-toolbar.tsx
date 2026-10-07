"use client";

import { cn } from "@/lib/utils";
import { RefreshCw, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { fmtRelative, fmtTime } from "@/lib/format";
import { EnvSelector } from "@/components/dashboard/shell";

// ============================================================
// Page toolbar — appears above each section
//
// "Updated … ago" is the age of the newest data in the query cache (not a mock
// clock), and Refresh refetches every active query. Views already poll every
// 30s on their own, so there is no separate auto-refresh switch; the old
// Auto/Export controls did nothing and were removed.
// ============================================================
export function PageToolbar({
  env,
  onEnvChange,
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
  const newest = updatedAt.length > 0 ? Math.max(...updatedAt) : null;
  const lastLoaded = newest !== null ? new Date(newest).toISOString() : null;

  // Ticks every second so "Updated 15s ago" stays live. `now` starts null and is set
  // after mount, so the server render and the first client render match.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const ago = newest === null || now === null ? "—" : now - newest < 5000 ? "just now" : `${fmtRelative(lastLoaded, now)} ago`;

  return (
    <div
      className={cn(
        "sticky top-12 z-20 flex items-center gap-2 border-b border-border bg-background/85 px-3 py-1.5 backdrop-blur md:top-0 md:px-6",
        className,
      )}
    >
      {envAware && <EnvSelector env={env} onEnvChange={onEnvChange} className="min-w-0 flex-1 sm:w-60 sm:flex-none" />}

      <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground" title={fmtTime(lastLoaded)}>
        <Clock className="h-3 w-3" aria-hidden />
        <span className="font-mono nums">Updated {ago}</span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => qc.invalidateQueries()}
          disabled={fetching}
          aria-label="Refresh"
          title={`Refresh · loaded ${fmtTime(lastLoaded)}`}
          className="h-8 gap-1.5"
        >
          <RefreshCw className={cn("h-3 w-3", fetching && "animate-spin")} />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>
    </div>
  );
}
