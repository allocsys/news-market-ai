"use client";

import { cn } from "@/lib/utils";
import { RefreshCw, Download, Clock, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useState, useEffect } from "react";
import { NOW_ISO } from "@/lib/mock-data";
import { fmtTime } from "@/lib/format";

// ============================================================
// Page toolbar — appears above each section
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
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastLoaded, setLastLoaded] = useState(NOW_ISO);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => setLastLoaded(new Date().toISOString()), 30_000);
    return () => clearInterval(id);
  }, [autoRefresh]);

  const onManualRefresh = () => setLastLoaded(new Date().toISOString());

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
        {/* Auto-refresh */}
        <label className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs">
          <span className="text-muted-foreground">Auto</span>
          <Switch
            checked={autoRefresh}
            onCheckedChange={setAutoRefresh}
            className="scale-75"
            aria-label="Toggle auto-refresh"
          />
        </label>

        <Button
          variant="outline"
          size="sm"
          onClick={onManualRefresh}
          className="h-8 gap-1.5"
        >
          <RefreshCw className="h-3 w-3" />
          <span className="hidden sm:inline">Refresh</span>
        </Button>

        {/* Export */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <Download className="h-3 w-3" />
              <span className="hidden sm:inline">Export</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem>Export as CSV</DropdownMenuItem>
            <DropdownMenuItem>Export as JSON</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
