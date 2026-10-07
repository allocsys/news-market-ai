"use client";

import { Loader2, HeartPulse } from "lucide-react";
import { useHealth, useActiveTickers, useMacro } from "@/lib/api";
import { SectionHeading, StatusDot, Pill, ErrorState } from "../primitives";
import { fmtTime, fmtRelative, fmtCompact } from "@/lib/format";
import {
  activeOrNull,
  hasEdgarTicker,
  hasMacroTicker,
  type SourceState,
} from "@/lib/ingest-scope";
import type { IngestionHealthSource } from "@/lib/types";
import type { ViewProps } from "./types";

const STALE_HOURS = 26;

interface SourceRow {
  key: string;
  label: string;
  data: IngestionHealthSource | null | undefined;
  state: SourceState;
  /** Why the source is not counted (shown under the label for na/off). */
  note?: string;
}

export function HealthView({}: ViewProps) {
  const health = useHealth();
  const activeTickers = useActiveTickers();
  const macro = useMacro();

  if (health.isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading health…
      </div>
    );
  }
  if (health.isError || !health.data) {
    return <ErrorState message={health.error?.message ?? "Failed to load health"} />;
  }

  const h = health.data.health;
  // null = unknown (loading / failed): every source is then treated as applicable.
  const active = activeOrNull(activeTickers.data);
  const timed = (d: IngestionHealthSource | null | undefined): SourceState =>
    (d?.fresh ?? isFresh(d?.lastIngestedAt)) ? "fresh" : "stale";

  const sources: SourceRow[] = [
    { key: "news", label: "News items", data: h.news, state: timed(h.news) },
    { key: "priceBars", label: "Price bars", data: h.priceBars, state: timed(h.priceBars) },
    hasEdgarTicker(active)
      ? { key: "fundamentals", label: "Fundamentals", data: h.fundamentals, state: timed(h.fundamentals) }
      : {
          key: "fundamentals",
          label: "Fundamentals",
          data: h.fundamentals,
          state: "na",
          note: "No active ticker has an EDGAR filer",
        },
  ];

  // Macro row: only when the backend reports it (older backends omit it) and the
  // switch state is known. An unknown switch hides the row rather than risk a
  // false "stale" on a default-off feature.
  const macroFlag = macro.data && !macro.data.error ? macro.data.enabled : null;
  if (h.macro !== undefined && macroFlag !== null) {
    if (!hasMacroTicker(active)) {
      sources.push({ key: "macro", label: "Macro (FRED + COT)", data: h.macro, state: "na", note: "XAUUSD is not active" });
    } else if (!macroFlag) {
      sources.push({ key: "macro", label: "Macro (FRED + COT)", data: h.macro, state: "off", note: "Switched off in Controls" });
    } else {
      sources.push({ key: "macro", label: "Macro (FRED + COT)", data: h.macro, state: timed(h.macro) });
    }
  }

  const counted = sources.filter((s) => s.state === "fresh" || s.state === "stale");
  const freshCount = counted.filter((s) => s.state === "fresh").length;
  const skipped = sources.length - counted.length;

  return (
    <div className="space-y-5">
      <section>
        <SectionHeading
          title="Ingestion health"
          description={`${freshCount}/${counted.length} sources fresh · ${STALE_HOURS}h staleness threshold${
            skipped > 0 ? ` · ${skipped} not counted` : ""
          }`}
          action={
            <Pill
              tone={
                counted.length === 0
                  ? "muted"
                  : freshCount === counted.length
                    ? "long"
                    : freshCount > 0
                      ? "paused"
                      : "short"
              }
              size="sm"
            >
              {freshCount}/{counted.length} fresh
            </Pill>
          }
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Each source is fresh when <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">lastIngestedAt</code> falls within the last {STALE_HOURS} hours.
          Sources that cannot apply to the active tickers, or are switched off, are shown but not counted.
        </p>
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <ul className="divide-y divide-border">
          {sources.map((s) => {
            const data = s.data;
            const inactive = s.state === "na" || s.state === "off";
            return (
              <li key={s.key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                <div className="sm:w-48">
                  <div className="flex items-center gap-2">
                    <StatusDot status={s.state === "fresh" ? "ok" : s.state === "stale" ? "stale" : "complete"} />
                    <span className="text-sm font-medium">{s.label}</span>
                  </div>
                  {s.note && <p className="mt-0.5 pl-4 text-[10px] text-muted-foreground">{s.note}</p>}
                </div>
                <div className="flex flex-1 items-center gap-3 text-xs">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Rows</p>
                    <p className="font-mono nums text-sm font-semibold">
                      {data ? fmtCompact(data.count) : "—"}
                    </p>
                  </div>
                  <div className="sm:ml-auto sm:text-right">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Last ingested</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {data?.lastIngestedAt ? fmtTime(data.lastIngestedAt) : "—"}
                    </p>
                    {data?.lastIngestedAt && (
                      <p className="text-[10px] text-muted-foreground">
                        {fmtRelative(data.lastIngestedAt)}
                      </p>
                    )}
                  </div>
                  <Pill tone={inactive ? "muted" : s.state === "fresh" ? "long" : "short"} size="sm">
                    {s.state === "na" ? "Not applicable" : s.state === "off" ? "Disabled" : s.state === "fresh" ? "Fresh" : "Stale"}
                  </Pill>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="rounded-xl border border-border bg-muted/20 p-4">
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <HeartPulse className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          The 26-hour threshold covers one full trading day plus a margin for the 15-minute ingest cron.
          Sources go stale when no new items have been ingested within that window — usually because of a
          paused ingestion switch, a vendor outage, or an API key problem.
        </p>
      </section>
    </div>
  );
}

function isFresh(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso).getTime();
  const now = Date.now();
  return now - d < STALE_HOURS * 60 * 60 * 1000;
}
