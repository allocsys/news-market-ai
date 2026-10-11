"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Download, AlertTriangle, Loader2 } from "lucide-react";
import {
  useBackfillJobs,
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

// Macro (FRED + COT) is XAUUSD-only and has no end date: it always runs from the range start to now.
const MACRO_TICKER = "XAUUSD";

type Kind = "news" | "prices" | "macro";

export function BackfillView({}: ViewProps) {
  const [from, setFrom] = useState(() => daysAgo(30));
  const [to, setTo] = useState(() => daysAgo(0));
  const [tickers, setTickers] = useState<string[]>([]);
  const [kinds, setKinds] = useState<Record<Kind, boolean>>({ news: true, prices: true, macro: false });
  const [confirmOpen, setConfirmOpen] = useState(false);

  // One batched query for all three jobs (running, else last finished); polls only while one is in flight.
  const jobsQuery = useBackfillJobs();
  const newsMutation = usePostBackfill();
  const priceMutation = usePostBackfillPrices();
  const macroMutation = usePostBackfillMacro();
  const macroQuery = useMacro();
  const watchlistQuery = useWatchlist();
  const watchlist = watchlistQuery.data?.tickers ?? [];
  // Intraday backfill progress rides the /api/overview response (same batched inputs read as ingestion health), so this
  // adds no request of its own: the query key is shared with the Overview view.
  const overviewQuery = useOverview();
  const intraday = overviewQuery.data?.health?.intradayBackfill ?? null;

  // Empty selection = the whole watchlist, which includes XAUUSD when it is on the watchlist.
  const macroAvailable = tickers.length === 0 ? watchlist.includes(MACRO_TICKER) : tickers.includes(MACRO_TICKER);
  const macroOn = kinds.macro && macroAvailable;
  const selected: Kind[] = [kinds.news && "news", kinds.prices && "prices", macroOn && "macro"].filter(Boolean) as Kind[];
  const pending = newsMutation.isPending || priceMutation.isPending || macroMutation.isPending;

  const toggleTicker = (t: string) => {
    setTickers((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  };
  const toggleKind = (k: Kind) => setKinds((prev) => ({ ...prev, [k]: !prev[k] }));

  const requestStart = () => {
    if (!from || !to) {
      toast.error("Pick both a start and an end date");
      return;
    }
    if (from > to) {
      toast.error("The start date must be on or before the end date");
      return;
    }
    if (selected.length === 0) {
      toast.error("Pick at least one of News, Prices or Macro");
      return;
    }
    setConfirmOpen(true);
  };

  const start = async () => {
    // Each type keeps its own endpoint and job row; they are simply fired together.
    const runs: Array<[string, Promise<unknown>]> = [];
    if (selected.includes("news")) runs.push(["News", newsMutation.mutateAsync({ from, to, tickers })]);
    if (selected.includes("prices")) runs.push(["Prices", priceMutation.mutateAsync({ from, to, tickers })]);
    if (selected.includes("macro")) runs.push(["Macro", macroMutation.mutateAsync({ from })]);
    const results = await Promise.allSettled(runs.map(([, p]) => p));
    const ok = runs.filter((_, i) => results[i].status === "fulfilled").map(([n]) => n);
    if (ok.length > 0) toast.success(`Started: ${ok.join(", ")}`);
    results.forEach((r, i) => {
      if (r.status === "rejected") toast.error(`${runs[i][0]} failed: ${(r.reason as Error)?.message ?? "error"}`);
    });
  };

  const scope = tickers.length === 0 ? `the whole watchlist (${watchlist.length} tickers)` : tickers.join(", ");

  return (
    <div className="space-y-5">
      {/* Intraday backfill (cron-driven; no job row, so progress comes from intraday_backfill_status) */}
      {intraday && intraday.tickers.length > 0 && <IntradayBackfillCard status={intraday} />}

      {/* Job progress for the three on-demand backfills */}
      <BackfillProgressCard
        rows={[
          { label: "News", job: jobsQuery.data?.news ?? null },
          { label: "Prices", job: jobsQuery.data?.prices ?? null },
          { label: "Macro", job: jobsQuery.data?.macro ?? null },
        ]}
      />

      <section>
        <SectionHeading
          title="Backfill"
          description="Historical news (Finnhub), daily prices (Tiingo) and XAUUSD macro (FRED + COT)"
        />
        <div className="mt-3 space-y-4 rounded-xl border border-border bg-card p-4">
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Tickers</p>
            <div className="flex flex-wrap gap-2">
              {watchlist.map((t) => (
                <label
                  key={t}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors",
                    tickers.includes(t)
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Checkbox checked={tickers.includes(t)} onCheckedChange={() => toggleTicker(t)} className="h-3.5 w-3.5" />
                  <span className="font-mono">{t}</span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">Leave empty to backfill the whole watchlist.</p>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Date range</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="bf-from" className="mb-1 block text-[10px] text-muted-foreground">From</label>
                <input
                  id="bf-from"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-mono"
                />
              </div>
              <div>
                <label htmlFor="bf-to" className="mb-1 block text-[10px] text-muted-foreground">To</label>
                <input
                  id="bf-to"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
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
                    setFrom(r.from);
                    setTo(r.to);
                  }}
                  className="rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Data</p>
            <div className="flex flex-wrap gap-2">
              <KindChip label="News" checked={kinds.news} onToggle={() => toggleKind("news")} />
              <KindChip label="Prices" checked={kinds.prices} onToggle={() => toggleKind("prices")} />
              <KindChip
                label="Macro"
                checked={macroOn}
                disabled={!macroAvailable}
                onToggle={() => toggleKind("macro")}
              />
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {macroAvailable
                ? "Macro has no end date: it runs from the start date to now, even when the live macro switch is off."
                : "Macro is XAUUSD-only; select XAUUSD (or no tickers) to enable it."}
            </p>
          </div>

          {kinds.news && (
            <div className="flex items-start gap-2 rounded-lg border border-[color:var(--paused)]/25 bg-[color:var(--paused)]/8 px-3 py-2 text-xs">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--paused)]" aria-hidden />
              <p className="text-muted-foreground">
                News makes real Finnhub API calls and spends free-tier quota. ~29 MB per 10K articles.
              </p>
            </div>
          )}
          {macroOn && macroQuery.data && !macroQuery.data.hasFredKey && (
            <div className="flex items-start gap-2 rounded-lg border border-[color:var(--paused)]/25 bg-[color:var(--paused)]/8 px-3 py-2 text-xs">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--paused)]" aria-hidden />
              <p className="text-muted-foreground">FRED_API_KEY is not configured: only the CFTC COT half will run.</p>
            </div>
          )}

          <div className="flex justify-end">
            <Button size="sm" onClick={requestStart} disabled={pending}>
              {pending ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Submitting…
                </>
              ) : (
                <>
                  <Download className="mr-1 h-3 w-3" />
                  Start backfill
                </>
              )}
            </Button>
          </div>
        </div>
      </section>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start backfill?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1.5 text-sm">
                <p>
                  {from} → {to} for {scope}.
                </p>
                <ul className="list-disc pl-5">
                  {selected.includes("news") && <li>News: Finnhub, spends free-tier API quota.</li>}
                  {selected.includes("prices") && <li>Prices: Tiingo daily bars.</li>}
                  {selected.includes("macro") && <li>Macro: FRED + CFTC gold, XAUUSD only, from {from} to now.</li>}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void start()}>Start</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function KindChip({
  label,
  checked,
  disabled,
  onToggle,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors",
        disabled
          ? "cursor-not-allowed border-border bg-muted/20 text-muted-foreground/50"
          : checked
            ? "cursor-pointer border-primary bg-primary/15 text-primary"
            : "cursor-pointer border-border bg-muted/40 text-muted-foreground hover:text-foreground",
      )}
    >
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={onToggle} className="h-3.5 w-3.5" />
      <span>{label}</span>
    </label>
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

/** One bar per on-demand backfill type (latest job each), same look as the intraday card. Hidden until any job exists. */
function BackfillProgressCard({ rows }: { rows: Array<{ label: string; job: JobProgress | null }> }) {
  const present = rows.filter((r): r is { label: string; job: JobProgress } => r.job != null);
  if (present.length === 0) return null;
  return (
    <section>
      <SectionHeading title="Backfill progress" description="Latest news, price and macro jobs" />
      <div className="mt-3 space-y-3 rounded-xl border border-border bg-card p-4">
        {present.map(({ label, job }) => {
          const isComplete = job.status === "complete";
          const isError = job.status === "failed";
          const isRunning = job.status === "running" || job.status === "queued";
          const pct = isComplete ? 100 : Math.max(0, Math.min(100, Math.round(job.percent ?? 0)));
          const params = (job.params ?? {}) as Record<string, string>;
          const range = `${params.from ?? "—"} → ${job.type === "backfill_macro" ? "now" : (params.to ?? "—")}`;
          return (
            <div key={job.id}>
              <div className="mb-1 flex items-center gap-2 text-[10px]">
                {isRunning && <Loader2 className="h-3 w-3 animate-spin text-primary" aria-hidden />}
                <span className="font-medium text-foreground">{label}</span>
                <StatusBadge variant={isComplete ? "approved" : isError ? "rejected" : "neutral"} label={job.status} />
                <span className="ml-auto font-mono nums text-muted-foreground">
                  {job.done != null && job.total != null ? `${fmtCompact(job.done)}/${fmtCompact(job.total)} · ` : ""}
                  {pct}%
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${label} backfill`}>
                <div
                  className={cn("h-full rounded-full transition-all", isError ? "bg-[color:var(--short)]" : isRunning ? "bg-primary" : "bg-[color:var(--long)]")}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                <span className="font-mono nums">{range}</span>
                {params.tickers ? <span className="font-mono"> · {String(params.tickers)}</span> : null}
                {" · "}
                {isRunning ? `updated ${fmtRelative(job.updatedAt)}` : `finished ${fmtTime(job.finishedAt)}`}
                {job.detail ? ` · ${job.detail}` : ""}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
