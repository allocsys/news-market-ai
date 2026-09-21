"use client";

import { useState } from "react";
import { useDash } from "@/lib/dash/store";
import {
  JOBS, fmtRelativeTime, fmtPct,
} from "@/lib/dash/mock-data";
import { Panel, PageHeader, FilterPills } from "../shared/primitives";
import { StatusBadge } from "../shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  AlertTriangle, DatabaseBackup, Loader2, Play,
} from "lucide-react";

const QUICK_RANGES = [
  { value: "7", label: "Last 7d" },
  { value: "14", label: "Last 14d" },
  { value: "30", label: "Last 30d" },
  { value: "90", label: "Last 90d" },
];

const todayStr = new Date().toISOString().slice(0, 10);
const daysAgoStr = (d: number) => new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10);

export function BackfillView() {
  const [newsFrom, setNewsFrom] = useState(daysAgoStr(7));
  const [newsTo, setNewsTo] = useState(todayStr);
  const [priceTickers, setPriceTickers] = useState("AAPL,MSFT,NVDA");
  const [priceFrom, setPriceFrom] = useState(daysAgoStr(14));
  const [priceTo, setPriceTo] = useState(todayStr);
  const [confirm, setConfirm] = useState<"news" | "prices" | null>(null);

  const appendAudit = useDash((s) => s.appendAudit);
  const currentUser = useDash((s) => s.currentUser);

  const lastNewsRun = JOBS.find((j) => j.kind === "backfill_news");

  function trigger(kind: "news" | "prices") {
    setConfirm(null);
    toast.success(`${kind === "news" ? "News" : "Price"} backfill started`, {
      description: kind === "news"
        ? `Range: ${newsFrom} → ${newsTo}. Real Finnhub API calls in flight.`
        : `Tickers: ${priceTickers}. Range: ${priceFrom} → ${priceTo}.`,
    });
    appendAudit({
      action: `Triggered ${kind === "news" ? "news" : "price"} backfill`,
      target: kind === "news"
        ? `${newsFrom} → ${newsTo}`
        : `${priceTickers} (${priceFrom} → ${priceTo})`,
      ip: "10.0.4.22",
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Backfill"
        description="Trigger historical data backfill. News backfills consume Finnhub API quota (free-tier: 60 calls/min). Price backfills consume Tiingo quota. Both use Post/Redirect/Get to avoid re-submit on refresh."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
        {/* News backfill */}
        <Panel title="News backfill" subtitle="Finnhub · real API calls · spends free-tier quota">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="news-from" className="text-xs">From</Label>
                <Input id="news-from" type="date" value={newsFrom} onChange={(e) => setNewsFrom(e.target.value)} className="h-9 mt-1" />
              </div>
              <div>
                <Label htmlFor="news-to" className="text-xs">To</Label>
                <Input id="news-to" type="date" value={newsTo} onChange={(e) => setNewsTo(e.target.value)} className="h-9 mt-1" />
              </div>
            </div>
            <div>
              <Label className="text-xs">Quick ranges</Label>
              <div className="mt-1.5">
                <FilterPills
                  pills={QUICK_RANGES}
                  value=""
                  onChange={(v) => {
                    setNewsFrom(daysAgoStr(parseInt(v, 10)));
                    setNewsTo(todayStr);
                  }}
                  ariaLabel="Quick news range"
                />
              </div>
            </div>
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs flex items-start gap-2">
              <AlertTriangle className="size-3.5 text-amber-500 shrink-0 mt-0.5" />
              <span className="text-amber-700 dark:text-amber-300">
                This action makes real Finnhub API calls and spends free-tier quota. Estimate: ~1 call per ticker per day in range.
              </span>
            </div>
            <Button onClick={() => setConfirm("news")} className="w-full h-10 gap-1.5" variant="default">
              <Play className="size-3.5" /> Trigger news backfill
            </Button>
          </div>
        </Panel>

        {/* Price backfill */}
        <Panel title="Price backfill" subtitle="Tiingo · real API calls · spends quota">
          <div className="space-y-3">
            <div>
              <Label htmlFor="price-tickers" className="text-xs">Tickers (comma-separated)</Label>
              <Input
                id="price-tickers"
                value={priceTickers}
                onChange={(e) => setPriceTickers(e.target.value)}
                placeholder="AAPL,MSFT,NVDA"
                className="h-9 mt-1 font-mono text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="price-from" className="text-xs">From</Label>
                <Input id="price-from" type="date" value={priceFrom} onChange={(e) => setPriceFrom(e.target.value)} className="h-9 mt-1" />
              </div>
              <div>
                <Label htmlFor="price-to" className="text-xs">To</Label>
                <Input id="price-to" type="date" value={priceTo} onChange={(e) => setPriceTo(e.target.value)} className="h-9 mt-1" />
              </div>
            </div>
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs flex items-start gap-2">
              <AlertTriangle className="size-3.5 text-amber-500 shrink-0 mt-0.5" />
              <span className="text-amber-700 dark:text-amber-300">
                This action makes real Tiingo API calls. Estimate: ~1 call per ticker for the full date range.
              </span>
            </div>
            <Button onClick={() => setConfirm("prices")} className="w-full h-10 gap-1.5">
              <Play className="size-3.5" /> Trigger price backfill
            </Button>
          </div>
        </Panel>
      </div>

      {/* Live + last-run panels */}
      <Panel title="Jobs in flight" subtitle="Polls /dashboard/jobs/:id every 1.5s; pauses when tab hidden">
        {JOBS.length === 0 ? (
          <div className="text-sm text-muted-foreground">No jobs currently running.</div>
        ) : (
          <div className="space-y-3">
            {JOBS.map((job) => (
              <div key={job.id} className="rounded-xl border border-border bg-card p-3.5">
                <div className="flex items-center gap-3 mb-2">
                  <div className={job.status === "running" ? "size-2 rounded-full bg-blue-500 pulse-dot" : job.status === "complete" ? "size-2 rounded-full bg-emerald-500" : "size-2 rounded-full bg-red-500"} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{job.kind.replace(/_/g, " ")} · <span className="font-mono text-xs text-muted-foreground">{job.id}</span></div>
                    <div className="text-xs text-muted-foreground truncate">{job.phase}</div>
                  </div>
                  <StatusBadge kind={job.status as "running" | "complete" | "failed"} />
                </div>
                {job.status === "running" && (
                  <div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className="h-full bg-blue-500 transition-all" style={{ width: `${(job.done / job.total) * 100}%` }} />
                    </div>
                    <div className="flex justify-between mt-1 text-[10px] text-muted-foreground tabular">
                      <span>{job.done} / {job.total}</span>
                      <span>started {fmtRelativeTime(job.startedAt)} · by @{job.triggeredBy}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Confirm dialog */}
      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <DatabaseBackup className="size-4" /> Confirm {confirm === "news" ? "news" : "price"} backfill
            </DialogTitle>
            <DialogDescription>
              This action will spend real API quota. Proceed only if you understand the cost.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm py-2">
            {confirm === "news" ? (
              <>
                <Row label="Range" value={`${newsFrom} → ${newsTo}`} />
                <Row label="Source" value="Finnhub news" />
                <Row label="Est. calls" value={`${Math.max(1, Math.round((new Date(newsTo).getTime() - new Date(newsFrom).getTime()) / 86400_000))} calls (1 per day)`} />
                <Row label="Triggered by" value={currentUser?.displayName ?? "—"} />
              </>
            ) : confirm === "prices" ? (
              <>
                <Row label="Tickers" value={priceTickers} />
                <Row label="Range" value={`${priceFrom} → ${priceTo}`} />
                <Row label="Source" value="Tiingo prices" />
                <Row label="Est. calls" value={`${priceTickers.split(",").filter(Boolean).length} calls (1 per ticker)`} />
                <Row label="Triggered by" value={currentUser?.displayName ?? "—"} />
              </>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button onClick={() => confirm && trigger(confirm)} className="gap-1.5">
              <Loader2 className="size-3.5 opacity-0" /> Confirm & run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center gap-3 py-1 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground uppercase tracking-wider">{label}</span>
      <span className="text-sm font-medium tabular">{value}</span>
    </div>
  );
}
