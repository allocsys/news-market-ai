"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { JobProgress } from "@/lib/types";

// Same cutoff as the backend's ACTIVE_JOB_MAX_IDLE_MS (src/storage/jobs.js): a queued/running job idle this long
// has most likely lost its terminal write (or the run is paused, which freezes job_progress too).
const STALE_AFTER_MS = 15 * 60 * 1000;

/** True when the job is still queued/running but has stopped ticking. */
export function isJobStalled(job: JobProgress, now: number = Date.now()): boolean {
  if (job.status !== "queued" && job.status !== "running") return false;
  if (job.stale) return true;
  const updated = Date.parse(job.updatedAt);
  return Number.isFinite(updated) && now - updated > STALE_AFTER_MS;
}

/**
 * Progress card for an in-flight job. Shows "queued" before the first tick and, instead of a bar that looks live
 * forever, a "stalled" notice when the job has stopped updating.
 */
export function JobProgressCard({
  job,
  label,
  action,
  children,
}: {
  job: JobProgress;
  /** "Backtest", "Backfill", ... */
  label: string;
  /** Small link/button shown at the top right. */
  action?: ReactNode;
  /** Extra controls under the bar (e.g. a Terminate button). */
  children?: ReactNode;
}) {
  const stalled = isJobStalled(job);
  const queued = job.status === "queued";
  const tone = stalled ? "var(--paused)" : "var(--info)";
  const pct = Math.max(0, Math.min(100, Number(job.percent) || 0));
  const heading = stalled ? `${label} stalled` : queued ? `${label} queued` : `${label} running`;

  return (
    <section
      className="overflow-hidden rounded-xl border p-4"
      style={{
        borderColor: `color-mix(in srgb, ${tone} 25%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${tone} 5%, transparent)`,
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn("inline-block h-2 w-2 rounded-full", !stalled && "live-dot")}
          style={{ backgroundColor: tone }}
        />
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: tone }}>
          {heading}
        </span>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <p className="mt-2 text-sm">
        {stalled
          ? "No progress for over 15 minutes. The job has likely stopped, or the run is paused. Check the run's status for the real state."
          : job.detail || (queued ? "Waiting to start…" : "Working…")}
      </p>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={`${label} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: tone }} />
      </div>
      {job.total ? (
        <p className="mt-1 text-right font-mono text-[10px] text-muted-foreground nums">
          {job.done ?? 0} / {job.total}
        </p>
      ) : null}
      {children}
    </section>
  );
}
