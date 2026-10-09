"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Download,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";
import {
  useLatestJob,
  usePostBackfill,
  usePostBackfillPrices,
  usePostBackfillMacro,
  useMacro,
  useWatchlist,
  useOverview,
} from "@/lib/api";
import type { JobProgress, IntradayBackfillStatus } from "@/lib/types";
import { SectionHeading, StatusBadge } from "../primitives";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { fmtTime, fmtRelative, fmtCompact } from "@/lib/format";
import { toast } from "sonner";
import { daysAgo, RANGE_PRESETS, presetRange } from "@/lib/date-range";
import type { ViewProps } from "./types";

// Macro backfill has no end date (FRED is always fetched from `from` to now), so its presets are
// just how far back to start.
const MACRO_PRESETS = [
  { label: "1y", days: 365 },
  { label: "2y", days: 730 },
  { label: "5y", days: 1825 },
  { label: "10y", days: 3650 },
];

export function BackfillView({}: ViewProps) {
  const [newsFrom, setNewsFrom] = useState(() => daysAgo(30));
  const [newsTo, setNewsTo] = useState(() => daysAgo(0));
  const [priceFrom, setPriceFrom] = useState(() => daysAgo(90));
  const [priceTo, setPriceTo] = useState(() => daysAgo(0));
  const [priceTickers, setPriceTickers] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<"news" | "prices" | "macro" | null>(null);
  const [macroFrom, setMacroFrom] = useState(() => daysAgo(730));

  const newsJob = useLatestJob("backfill");
  const priceJob = useLatestJob("backfill_prices");
  const newsMutation = usePostBackfill();
  const priceMutation = usePostBackfillPrices();
  const macroJob = useLatestJob("backfill_macro");
  const macroMutation = usePostBackfillMacro();
  const macroQuery = useMacro();
  const watchlistQuery = useWatchlist();
  const watchlist = (watchlistQuery.data?.tickers ?? []).map((ticker) => ({ ticker }));
  // Intraday backfill progress rides the /api/overview response (same batched inputs read as ingestion health), so this
  // adds no request of its own: the query key is shared with the Overview view.
  const overviewQuery = useOverview();
  const intraday = overviewQuery.data?.health?.intradayBackfill ?? null;

  const toggleTicker = (t: string) => {
    setPriceTickers((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  };

  // ISO dates (YYYY-MM-DD) compare correctly as strings.
  const validRange = (from: string, to: string) => {
    if (!from || !to) {
      toast.error("Pick both a start and an end date");
      return false;
    }
    if (from > to) {
      toast.error("The start date must be on or before the end date");
      return false;
    }
    return true;
  };
  const requestNews = () => {
    if (validRange(newsFrom, newsTo)) setConfirm("news");
  };
  const requestPrices = () => {
    if (validRange(priceFrom, priceTo)) setConfirm("prices");
  };

  const requestMacro = () => {
    if (!macroFrom) {
      toast.error("Pick a start date");
      return;
    }
    if (macroFrom > daysAgo(0)) {
      toast.error("The start date must not be in the future");
      return;
    }
    setConfirm("macro");
  };

  const submitNews = () => {
    newsMutation.mutate(
      { from: newsFrom, to: newsTo },
      {
        onSuccess: () => toast.success("News backfill started"),
        onError: (e) => toast.error(`Failed: ${e.message}`),
      },
    );
  };

  const submitPrices = () => {
    priceMutation.mutate(
      { from: priceFrom, to: priceTo, tickers: priceTickers },
      {
        onSuccess: () => toast.success("Price backfill started"),
        onError: (e) => toast.error(`Failed: ${e.message}`),
      },
    );
  };

  const submitMacro = () => {
    macroMutation.mutate(
      { from: macroFrom },
      {
        onSuccess: () => toast.success("Macro backfill started"),
        onError: (e) => toast.error(`Failed: ${e.message}`),
      },
    );
  };

  return (
    <div className="space-y-5">
      {/* Intraday backfill (cron-driven; no job row, so progress comes from intraday_backfill_status) */}
      {intraday && intraday.tickers.length > 0 && <IntradayBackfillCard status={intraday} />}

      {/* News backfill */}
      <section>
        <SectionHeading
          title="News backfill"
          description="Historical news from Finnhub (the only backfill source)"
        />
        <div className="mt-3 space-y-4 rounded-xl border border-border bg-card p-4">
          {newsJob.data?.job && <JobSummary job={newsJob.data.job} label="Last news backfill" />}

          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Date range</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="news-from" className="mb-1 block text-[10px] text-muted-foreground">From</label>
                <input
                  id="news-from"
                  type="date"
                  value={newsFrom}
                  onChange={(e) => setNewsFrom(e.target.value)}
                  className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-mono"
                />
              </div>
              <div>
                <label htmlFor="news-to" className="mb-1 block text-[10px] text-muted-foreground">To</label>
                <input
                  id="news-to"
                  type="date"
                  value={newsTo}
                  onChange={(e) => setNewsTo(e.target.value)}
                  className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-mono"
                />
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {RANGE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    const r = presetRange(p.days);
                    setNewsFrom(r.from);
                    setNewsTo(r.to);
                  }}
                  className="rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-[color:var(--paused)]/25 bg-[color:var(--paused)]/8 px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--paused)]" aria-hidden />
            <p className="text-muted-foreground">
              Cost warning: this makes real Finnhub API calls and spends free-tier quota. ~29 MB per 10K articles.
            </p>
          </div>

          <div className="flex justify-end">
            <Button size="sm" onClick={requestNews} disabled={newsMutation.isPending}>
              {newsMutation.isPending ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Submitting…
                </>
              ) : (
                <>
                  <Download className="mr-1 h-3 w-3" />
                  Backfill news
                </>
              )}
            </Button>
          </div>
        </div>
      </section>

      {/* Price backfill */}
      <section>
        <SectionHeading title="Price backfill" description="Historical daily bars from Tiingo" />
        <div className="mt-3 space-y-4 rounded-xl border border-border bg-card p-4">
          {priceJob.data?.job && <JobSummary job={priceJob.data.job} label="Last price backfill" />}

          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Date range</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="price-from" className="mb-1 block text-[10px] text-muted-foreground">From</label>
                <input
                  id="price-from"
                  type="date"
                  value={priceFrom}
                  onChange={(e) => setPriceFrom(e.target.value)}
                  className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-mono"
                />
              </div>
              <div>
                <label htmlFor="price-to" className="mb-1 block text-[10px] text-muted-foreground">To</label>
                <input
                  id="price-to"
                  type="date"
                  value={priceTo}
                  onChange={(e) => setPriceTo(e.target.value)}
                  className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-mono"
                />
              </div>
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Tickers</p>
            <div className="flex flex-wrap gap-2">
              {watchlist.map((t) => (
                <label
                  key={t.ticker}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors",
                    priceTickers.includes(t.ticker)
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Checkbox
                    checked={priceTickers.includes(t.ticker)}
                    onCheckedChange={() => toggleTicker(t.ticker)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="font-mono">{t.ticker}</span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">Leave empty to backfill the whole watchlist.</p>
          </div>

          <div className="flex justify-end">
            <Button size="sm" onClick={requestPrices} disabled={priceMutation.isPending}>
              {priceMutation.isPending ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Submitting…
                </>
              ) : (
                <>
                  <Download className="mr-1 h-3 w-3" />
                  Backfill prices
                </>
              )}
            </Button>
          </div>
        </div>
      </section>

      {/* Macro backfill */}
      <section>
        <SectionHeading
          title="Macro backfill"
          description="Historical FRED series and CFTC gold positioning (XAUUSD), from a start date to now"
        />
        <div className="mt-3 space-y-4 rounded-xl border border-border bg-card p-4">
          {macroJob.data?.job && <JobSummary job={macroJob.data.job} label="Last macro backfill" />}

          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Start date</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="macro-from" className="mb-1 block text-[10px] text-muted-foreground">From</label>
                <input
                  id="macro-from"
                  type="date"
                  value={macroFrom}
                  onChange={(e) => setMacroFrom(e.target.value)}
                  className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-mono"
                />
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {MACRO_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setMacroFrom(daysAgo(p.days))}
                  className="rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">
              FRED has no end bound, so this always runs from the start date to now. The live tick already covers the last ~4 months; use this for older windows. Runs even when the live macro switch is off.
            </p>
          </div>

          {macroQuery.data && !macroQuery.data.hasFredKey && (
            <div className="flex items-start gap-2 rounded-lg border border-[color:var(--paused)]/25 bg-[color:var(--paused)]/8 px-3 py-2 text-xs">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--paused)]" aria-hidden />
              <p className="text-muted-foreground">
                FRED_API_KEY is not configured: only the CFTC COT half will run.
              </p>
            </div>
          )}

          <div className="flex justify-end">
            <Button size="sm" onClick={requestMacro} disabled={macroMutation.isPending}>
              {macroMutation.isPending ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Submitting…
                </>
              ) : (
                <>
                  <Download className="mr-1 h-3 w-3" />
                  Backfill macro
                </>
              )}
            </Button>
          </div>
        </div>
      </section>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "news" ? "Start news backfill?" : confirm === "macro" ? "Start macro backfill?" : "Start price backfill?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "news"
                ? `Fetches Finnhub news from ${newsFrom} to ${newsTo} and spends free-tier API quota.`
                : confirm === "macro"
                  ? `Fetches FRED series and CFTC gold positioning from ${macroFrom} to now. Rows already stored keep their availability times.`
                  : `Fetches Tiingo daily bars from ${priceFrom} to ${priceTo} for ${priceTickers.length === 0 ? `the whole watchlist (${watchlist.length} tickers)` : priceTickers.join(", ")}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => (confirm === "news" ? submitNews() : confirm === "macro" ? submitMacro() : submitPrices())}>Start</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function IntradayBackfillCard({ status }: { status: IntradayBackfillStatus }) {
  const failed = status.tickers.reduce((n, t) => n + t.failed, 0);
  const pending = status.tickers.reduce((n, t) => n + t.pending, 0);
  return (
    <section>
      <SectionHeading
        title="Intraday backfill"
        description="5-minute bars, filled by the 15-minute cron tick"
      />
      <div className="mt-3 space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2">
          {status.active ? (
            <span className="inline-flex animate-pulse items-center gap-1 rounded-full border border-primary/40 bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              Running
            </span>
          ) : (
            <StatusBadge variant={failed > 0 ? "rejected" : "approved"} label={failed > 0 ? "Done, with failures" : "Complete"} />
          )}
          <span className="text-[10px] text-muted-foreground">
            {status.active ? `${pending} day${pending === 1 ? "" : "s"} left` : "nothing pending"}
            {failed > 0 ? ` · ${failed} failed` : ""}
          </span>
          {status.lastAttemptAt && (
            <span className="ml-auto text-[10px] text-muted-foreground">last tick {fmtRelative(status.lastAttemptAt)}</span>
          )}
        </div>
        <div className="space-y-2">
          {status.tickers.map((t) => {
            const pct = t.total > 0 ? Math.round((t.done / t.total) * 100) : 0;
            return (
              <div key={t.ticker}>
                <div className="mb-1 flex items-center justify-between text-[10px]">
                  <span className="font-mono font-medium text-foreground">{t.ticker}</span>
                  <span className="font-mono nums text-muted-foreground">
                    {t.done}/{t.total}
                    {t.failed > 0 ? ` · ${t.failed} failed` : ""}
                    {t.latestDate ? ` · to ${t.latestDate}` : ""}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${t.ticker} intraday backfill`}>
                  <div
                    className={cn("h-full rounded-full transition-all", t.failed > 0 ? "bg-[color:var(--short)]" : t.pending > 0 ? "bg-primary" : "bg-[color:var(--long)]")}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function JobSummary({ job, label }: { job: JobProgress; label: string }) {
  const isComplete = job.status === "complete";
  const isError = job.status === "failed";
  const isRunning = job.status === "running" || job.status === "queued";
  const pct = Math.max(0, Math.min(100, Math.round(job.percent ?? 0)));
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        {isComplete ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-[color:var(--long)]" />
        ) : isError ? (
          <XCircle className="h-3.5 w-3.5 text-[color:var(--short)]" />
        ) : isRunning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
        ) : null}
        <span className="text-xs font-medium">{label}</span>
        <StatusBadge
          variant={isComplete ? "approved" : isError ? "rejected" : "neutral"}
          label={job.status}
        />
        <span className="ml-auto text-[10px] text-muted-foreground">
          {fmtRelative(job.finishedAt ?? job.updatedAt)}
        </span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{job.detail}</p>
      {isRunning && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${label} progress`}>
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span>Range: <span className="font-mono nums">{(job.params as Record<string, string>)?.from ?? "—"} → {job.type === "backfill_macro" ? "now" : ((job.params as Record<string, string>)?.to ?? "—")}</span></span>
        {job.done != null && job.total != null && (
          <span>Items: <span className="font-mono nums">{fmtCompact(job.done)}/{fmtCompact(job.total)}</span></span>
        )}
        <span>Finished: <span className="font-mono nums">{fmtTime(job.finishedAt)}</span></span>
      </div>
    </div>
  );
}
