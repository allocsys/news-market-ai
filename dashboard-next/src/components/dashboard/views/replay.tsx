"use client";

// News replay comparison (backtest/newsReplay.js): pick a ticker + date, choose
// 1-5 ingested news items, and run each through BOTH the pre-#132 parallel
// analyst path and the current batched path; the two trade decisions are shown
// side by side. Real Gemini calls, but nothing is written to positions or
// decisions.

import { useState } from "react";
import { ChevronRight, Loader2, Play, Search } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useWatchlist, useReplayNews, usePostReplayRun } from "@/lib/api";
import type { JobProgress } from "@/lib/types";
import { fmtPct, fmtTime, signedPct } from "@/lib/format";
import { Pill, StatusBadge, ErrorState } from "../primitives";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

// Mirrors MAX_REPLAY_NEWS_ITEMS in src/index.js; the real limit is enforced server-side.
const MAX_REPLAY_ITEMS = 5;

interface ReplaySummary {
  direction?: string | null;
  confidence?: number | null;
  approvedForExecution?: boolean;
  positionSizePct?: number | null;
  stopLossPct?: number | null;
  takeProfitPct?: number | null;
  realizedReturnPct?: number | null;
  maxDrawdownPct?: number | null;
  exitReason?: string | null;
  holdDays?: number | null;
}
interface ReplayMode {
  summary?: ReplaySummary | null;
}
interface ReplayDiff {
  directionMatch?: boolean;
  approvedMatch?: boolean;
  positionSizePctDelta?: number | null;
  confidenceDelta?: number | null;
}
interface ReplayItemResult {
  newsItemId: string;
  asOf: string;
  parallel?: ReplayMode;
  batched?: ReplayMode;
  diff?: ReplayDiff | null;
}
interface ReplayJobResult {
  results?: ReplayItemResult[];
  missingNewsItemIds?: string[];
}
type ReplayJob = JobProgress & { result?: ReplayJobResult | null };

const today = () => new Date().toISOString().slice(0, 10);

export function ReplayPanel({ replayJobs, replayError }: { replayJobs: JobProgress[]; replayError: string | null }) {
  const watchlist = useWatchlist();
  const postReplay = usePostReplayRun();

  const tickers = watchlist.data?.tickers ?? [];
  const [ticker, setTicker] = useState("");
  const [date, setDate] = useState(today());
  const [query, setQuery] = useState<{ ticker: string; date: string } | null>(null);
  const [picked, setPicked] = useState<string[] | null>(null); // null = default (first item)
  const [asOf, setAsOf] = useState("");
  const [enableLlmLog, setEnableLlmLog] = useState(false);

  const tickerValue = (ticker || tickers[0] || "").trim().toUpperCase();
  const news = useReplayNews(query);
  const items = news.data?.items ?? [];
  const selected = picked ?? (items[0] ? [items[0].id] : []);

  const find = () => {
    if (!tickerValue) {
      toast.error("Enter a ticker");
      return;
    }
    setPicked(null);
    setQuery({ ticker: tickerValue, date });
  };

  const toggleItem = (id: string) => {
    setPicked((prev) => {
      const cur = prev ?? selected;
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      return cur.length >= MAX_REPLAY_ITEMS ? cur : [...cur, id];
    });
  };

  const run = () => {
    if (!query || selected.length === 0) return;
    postReplay.mutate(
      {
        ticker: query.ticker,
        newsItemIds: selected,
        asOf: asOf.trim() || undefined,
        enableLlmLog,
      },
      {
        onSuccess: () => {
          toast.success("Replay started");
          setQuery(null);
          setPicked(null);
          setAsOf("");
        },
        onError: (e) => toast.error(`Failed: ${e.message}`),
      },
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Runs each selected news item through both the pre-#132 parallel analyst path and the current batched path, and
        shows the two trade decisions side by side. Makes real Gemini calls; nothing is written to positions or trade
        decisions.
      </p>

      {/* Step 1: ticker + date */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="replay-ticker" className="mb-1 block text-[10px] text-muted-foreground">
            Ticker
          </label>
          {tickers.length > 0 ? (
            <select
              id="replay-ticker"
              value={tickerValue}
              onChange={(e) => setTicker(e.target.value)}
              className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-mono"
            >
              {tickers.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="replay-ticker"
              type="text"
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="AAPL"
              className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-mono uppercase"
            />
          )}
        </div>
        <div>
          <label htmlFor="replay-date" className="mb-1 block text-[10px] text-muted-foreground">
            News date (UTC)
          </label>
          <input
            id="replay-date"
            type="date"
            value={date}
            max={today()}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-mono"
          />
        </div>
      </div>
      <div className="flex justify-end">
        <Button variant="outline" size="sm" type="button" onClick={find} disabled={news.isFetching || !date}>
          {news.isFetching ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Search className="mr-1 h-3 w-3" />
          )}
          Find news items
        </Button>
      </div>

      {/* Step 2: pick items */}
      {query && news.isError && <ErrorState message={news.error?.message ?? "Failed to load news items"} />}
      {query && news.data && items.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No ingested news items found for <span className="font-mono">{news.data.ticker}</span> on {news.data.date}. Try a
          different date, or backfill news for this range first.
        </p>
      )}
      {query && items.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {items.length} news item{items.length === 1 ? "" : "s"} found for{" "}
            <span className="font-mono">{news.data?.ticker}</span> on {news.data?.date}. Pick 1-{MAX_REPLAY_ITEMS}.
          </p>
          <ul className="space-y-2">
            {items.map((it) => {
              const on = selected.includes(it.id);
              return (
                <li key={it.id}>
                  <label
                    className={cn(
                      "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-xs transition-colors",
                      on ? "border-primary bg-primary/10" : "border-border bg-muted/30",
                    )}
                  >
                    <Checkbox checked={on} onCheckedChange={() => toggleItem(it.id)} className="mt-0.5 h-3.5 w-3.5" />
                    <span className="min-w-0">
                      <span className="block font-medium">{it.title || "(untitled)"}</span>
                      <span className="block break-all text-[10px] text-muted-foreground">
                        {fmtTime(it.publishedAt)} · id {it.id}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          <div>
            <label htmlFor="replay-asof" className="mb-1 block text-[10px] text-muted-foreground">
              asOf override (optional ISO timestamp; blank uses each item&apos;s own publish time)
            </label>
            <input
              id="replay-asof"
              type="text"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              placeholder="2026-01-15T14:30:00.000Z"
              className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-mono"
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox
              checked={enableLlmLog}
              onCheckedChange={(v) => v !== "indeterminate" && setEnableLlmLog(!!v)}
              className="h-3.5 w-3.5"
            />
            <span className="text-xs">Enable LLM call logging for this run</span>
            <span className="text-[10px] text-muted-foreground">(to inspect the raw prompts and responses)</span>
          </label>

          <div className="flex justify-end">
            <Button size="sm" type="button" onClick={run} disabled={postReplay.isPending || selected.length === 0}>
              {postReplay.isPending ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Submitting…
                </>
              ) : (
                <>
                  <Play className="mr-1 h-3 w-3" />
                  Run replay comparison
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Recent replay comparisons */}
      <div className="space-y-2 border-t border-border pt-4">
        <div className="flex items-center gap-2">
          <span className="font-display text-sm font-semibold">Recent replay comparisons</span>
          <Pill tone="muted" size="sm">
            {replayJobs.length}
          </Pill>
        </div>
        {replayError && <ErrorState message={replayError} />}
        {replayJobs.length === 0 && !replayError ? (
          <p className="text-xs text-muted-foreground">
            No replay comparisons yet. Use the form above to compare parallel vs. batched analyst calls on a real
            historical news item.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {replayJobs.map((job) => (
              <ReplayJobRow key={job.id} job={job as ReplayJob} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const JOB_LABEL: Record<string, string> = {
  queued: "queued…",
  running: "running…",
  complete: "complete",
  failed: "failed",
  cancelled: "cancelled",
};

function ReplayJobRow({ job }: { job: ReplayJob }) {
  const live = job.status === "queued" || job.status === "running";
  const [open, setOpen] = useState(live);
  const p = job.params ?? {};
  const itemCount = Array.isArray(p.newsItemIds) ? p.newsItemIds.length : 0;
  const variant =
    job.status === "complete" ? "approved" : job.status === "failed" || job.status === "cancelled" ? "rejected" : "info";

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold">{String(p.ticker ?? "?")}</span>
            <StatusBadge variant={variant} label={JOB_LABEL[job.status] ?? job.status} />
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {itemCount} item{itemCount === 1 ? "" : "s"} · {fmtTime(job.createdAt)}
          </p>
        </div>
        <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border bg-muted/20 px-3 py-3">
          {job.status === "failed" && (
            <p className="break-words text-xs text-muted-foreground">
              {job.error ?? "failed with no recorded error message"}
            </p>
          )}
          {live && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">{job.detail || "Working…"}</p>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-[color:var(--info)] transition-all"
                  style={{ width: `${job.percent ?? 0}%` }}
                />
              </div>
            </div>
          )}
          {job.status === "complete" && <ReplayResults result={job.result} />}
        </div>
      )}
    </li>
  );
}

function ReplayResults({ result }: { result?: ReplayJobResult | null }) {
  const results = result?.results ?? [];
  const missing = result?.missingNewsItemIds ?? [];
  return (
    <div className="space-y-3">
      {results.length === 0 && <p className="text-xs text-muted-foreground">No results recorded.</p>}
      {results.map((item) => (
        <div key={item.newsItemId} className="space-y-2 rounded-lg border border-border bg-card p-3">
          <p className="break-all text-[11px] text-muted-foreground">
            News item {item.newsItemId} · as of {fmtTime(item.asOf)}
          </p>
          <ModeSummary label="Parallel (pre-#132)" summary={item.parallel?.summary} />
          <ModeSummary label="Batched (current)" summary={item.batched?.summary} />
          <DiffSummary diff={item.diff} />
        </div>
      ))}
      {missing.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {missing.length} requested news item{missing.length === 1 ? "" : "s"} could not be found and{" "}
          {missing.length === 1 ? "was" : "were"} skipped: {missing.join(", ")}
        </p>
      )}
    </div>
  );
}

function ModeSummary({ label, summary }: { label: string; summary?: ReplaySummary | null }) {
  if (!summary) {
    return (
      <div className="text-xs">
        <span className="font-semibold">{label}</span> —
      </div>
    );
  }
  const exit = summary.exitReason ? summary.exitReason.replace(/_/g, " ") : "no simulated exit";
  return (
    <div className="text-xs">
      <p>
        <span className="font-semibold">{label}</span> {summary.direction ?? "—"}, {fmtPct(summary.confidence, 0)}{" "}
        confidence, {summary.approvedForExecution ? "approved" : "not approved"}, size {fmtPct(summary.positionSizePct)}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        Stop {fmtPct(summary.stopLossPct)} · target {fmtPct(summary.takeProfitPct)} · PnL{" "}
        {summary.realizedReturnPct != null ? signedPct(summary.realizedReturnPct) : "—"} · drawdown{" "}
        {fmtPct(summary.maxDrawdownPct)} · exit: {exit} · hold {summary.holdDays != null ? `${summary.holdDays}d` : "—"}
      </p>
    </div>
  );
}

// Deltas are batched − parallel (newsReplay.js#diffOf's sign convention).
function DiffSummary({ diff }: { diff?: ReplayDiff | null }) {
  if (!diff) return null;
  const cells: { label: string; value: string; good?: boolean }[] = [
    { label: "Direction", value: diff.directionMatch ? "Match" : "Differ", good: !!diff.directionMatch },
    { label: "Approved", value: diff.approvedMatch ? "Match" : "Differ", good: !!diff.approvedMatch },
    {
      label: "Size Δ",
      value: diff.positionSizePctDelta != null ? `${signedPct(diff.positionSizePctDelta)}` : "—",
    },
    {
      label: "Confidence Δ",
      value: diff.confidenceDelta != null ? `${signedPct(diff.confidenceDelta, 0)}` : "—",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cells.map((c) => (
        <div key={c.label} className="rounded-md border border-border bg-muted/30 px-2 py-1.5">
          <p
            className={cn(
              "font-mono text-sm font-semibold",
              c.good === true && "text-[color:var(--long)]",
              c.good === false && "text-[color:var(--short)]",
            )}
          >
            {c.value}
          </p>
          <p className="text-[10px] text-muted-foreground">{c.label}</p>
        </div>
      ))}
    </div>
  );
}
