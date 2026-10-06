"use client";

import { Loader2, HeartPulse } from "lucide-react";
import { useHealth } from "@/lib/api";
import { SectionHeading, StatusDot, Pill, ErrorState } from "../primitives";
import { fmtTime, fmtRelative, fmtCompact } from "@/lib/format";
import type { ViewProps } from "./types";

const STALE_HOURS = 26;

export function HealthView({}: ViewProps) {
  const health = useHealth();

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
  const sources = [
    { key: "news", label: "News items", data: h.news },
    { key: "priceBars", label: "Price bars", data: h.priceBars },
    { key: "fundamentals", label: "Fundamentals", data: h.fundamentals },
  ];
  const freshCount = sources.filter((s) => s.data?.fresh ?? isFresh(s.data?.lastIngestedAt)).length;

  return (
    <div className="space-y-5">
      <section>
        <SectionHeading
          title="Ingestion health"
          description={`${freshCount}/${sources.length} sources fresh · ${STALE_HOURS}h staleness threshold`}
          action={
            <Pill tone={freshCount === sources.length ? "long" : freshCount > 0 ? "paused" : "short"} size="sm">
              {freshCount}/{sources.length} fresh
            </Pill>
          }
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Each source is fresh when <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">lastIngestedAt</code> falls within the last {STALE_HOURS} hours.
        </p>
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <ul className="divide-y divide-border">
          {sources.map((s) => {
            const data = s.data;
            const fresh = data?.fresh ?? isFresh(data?.lastIngestedAt);
            return (
              <li key={s.key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                <div className="flex items-center gap-2 sm:w-48">
                  <StatusDot status={fresh ? "ok" : "stale"} />
                  <span className="text-sm font-medium">{s.label}</span>
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
                  <Pill tone={fresh ? "long" : "short"} size="sm">
                    {fresh ? "Fresh" : "Stale"}
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
