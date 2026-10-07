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
  useWatchlist,
} from "@/lib/api";
import type { JobProgress } from "@/lib/types";
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

export function BackfillView({}: ViewProps) {
  const [newsFrom, setNewsFrom] = useState(() => daysAgo(30));
  const [newsTo, setNewsTo] = useState(() => daysAgo(0));
  const [priceFrom, setPriceFrom] = useState(() => daysAgo(90));
  const [priceTo, setPriceTo] = useState(() => daysAgo(0));
  const [priceTickers, setPriceTickers] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<"news" | "prices" | null>(null);

  const newsJob = useLatestJob("backfill");
  const priceJob = useLatestJob("backfill_prices");
  const newsMutation = usePostBackfill();
  const priceMutation = usePostBackfillPrices();
  const watchlistQuery = useWatchlist();
  const watchlist = (watchlistQuery.data?.tickers ?? []).map((ticker) => ({ ticker }));

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

  return (
    <div className="space-y-5">
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

      <AlertDialog open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "news" ? "Start news backfill?" : "Start price backfill?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "news"
                ? `Fetches Finnhub news from ${newsFrom} to ${newsTo} and spends free-tier API quota.`
                : `Fetches Tiingo daily bars from ${priceFrom} to ${priceTo} for ${priceTickers.length === 0 ? `the whole watchlist (${watchlist.length} tickers)` : priceTickers.join(", ")}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => (confirm === "news" ? submitNews() : submitPrices())}>Start</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function JobSummary({ job, label }: { job: JobProgress; label: string }) {
  const isComplete = job.status === "complete";
  const isError = job.status === "failed";
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        {isComplete ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-[color:var(--long)]" />
        ) : isError ? (
          <XCircle className="h-3.5 w-3.5 text-[color:var(--short)]" />
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
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span>Range: <span className="font-mono nums">{(job.params as Record<string, string>)?.from ?? "—"} → {(job.params as Record<string, string>)?.to ?? "—"}</span></span>
        {job.done != null && job.total != null && (
          <span>Items: <span className="font-mono nums">{fmtCompact(job.done)}/{fmtCompact(job.total)}</span></span>
        )}
        <span>Finished: <span className="font-mono nums">{fmtTime(job.finishedAt)}</span></span>
      </div>
    </div>
  );
}
