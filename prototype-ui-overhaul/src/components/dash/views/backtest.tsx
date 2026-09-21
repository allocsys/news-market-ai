"use client";

import { useState } from "react";
import { useDash } from "@/lib/dash/store";
import {
  BACKTEST_RUNS, BACKTEST_TRADES, buildEquityCurve,
  fmtPct, fmtRelativeTime,
} from "@/lib/dash/mock-data";
import { Panel, PageHeader } from "../shared/primitives";
import { StatusBadge } from "../shared/status-badge";
import { MiniStats } from "../shared/stat-card";
import { EquityCurve } from "../shared/equity-curve";
import { DataTable, type Column } from "../shared/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "sonner";
import {
  ChevronRight, FlaskConical, ArrowLeft, Play, AlertTriangle,
} from "lucide-react";
import type { BacktestRun, BacktestTrade } from "@/lib/dash/types";

export function BacktestView() {
  const backtestDetailId = useDash((s) => s.backtestDetailId);
  const openBacktest = useDash((s) => s.openBacktest);
  const appendAudit = useDash((s) => s.appendAudit);
  const currentUser = useDash((s) => s.currentUser);
  const setView = useDash((s) => s.setView);
  const tickerFilter = useDash((s) => s.tickerFilter);
  const tick = tickerFilter;

  const [tickers, setTickers] = useState("AAPL,MSFT,NVDA");
  const [testStart, setTestStart] = useState("2026-06-22");
  const [testEnd, setTestEnd] = useState("2026-09-21");
  const [graceDays, setGraceDays] = useState("5");
  const [runLabel, setRunLabel] = useState("");

  if (backtestDetailId) {
    const run = BACKTEST_RUNS.find((r) => r.id === backtestDetailId);
    return (
      <BacktestDetail
        run={run}
        onBack={() => openBacktest(null)}
        onJumpToLlm={() => setView("llm")}
      />
    );
  }

  const visible = tick
    ? BACKTEST_RUNS.filter((r) => r.tickers.includes(tick))
    : BACKTEST_RUNS;

  function trigger() {
    if (!tickers.trim()) {
      toast.error("Tickers required", { description: "Enter at least one ticker symbol." });
      return;
    }
    toast.success("Backtest queued", {
      description: `Tickers: ${tickers}. Window: ${testStart} → ${testEnd}.`,
    });
    appendAudit({
      action: "Triggered backtest run",
      target: `${tickers} · ${testStart} → ${testEnd} (grace ${graceDays}d)`,
      ip: "10.0.4.22",
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={tick ? `Backtest · ${tick}` : "Backtest"}
        description="Run historical simulations. Each backtest calls the LLM cascade for every decision tick — this consumes real Gemini API quota. Name your run to find it later."
      />

      <Panel title="Trigger a new run" subtitle="Each LLM call costs real Gemini API quota">
        <div className="space-y-3">
          <div>
            <Label htmlFor="run-label" className="text-xs">Run label (optional)</Label>
            <Input
              id="run-label"
              value={runLabel}
              onChange={(e) => setRunLabel(e.target.value)}
              placeholder="e.g. Tech conviction Q3"
              className="h-9 mt-1"
            />
          </div>
          <div>
            <Label htmlFor="bt-tickers" className="text-xs">Tickers (comma-separated)</Label>
            <Input
              id="bt-tickers"
              value={tickers}
              onChange={(e) => setTickers(e.target.value)}
              className="h-9 mt-1 font-mono text-xs"
            />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <Label htmlFor="bt-start" className="text-xs">Test start</Label>
              <Input id="bt-start" type="date" value={testStart} onChange={(e) => setTestStart(e.target.value)} className="h-9 mt-1" />
            </div>
            <div>
              <Label htmlFor="bt-end" className="text-xs">Test end</Label>
              <Input id="bt-end" type="date" value={testEnd} onChange={(e) => setTestEnd(e.target.value)} className="h-9 mt-1" />
            </div>
            <div>
              <Label htmlFor="bt-grace" className="text-xs">Grace days</Label>
              <Input id="bt-grace" type="number" min="1" max="30" value={graceDays} onChange={(e) => setGraceDays(e.target.value)} className="h-9 mt-1" />
            </div>
          </div>
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs flex items-start gap-2">
            <AlertTriangle className="size-3.5 text-amber-500 shrink-0 mt-0.5" />
            <span className="text-amber-700 dark:text-amber-300">
              A 90-day run on 3 tickers makes roughly {3 * 90} LLM calls — the deep_think tier is the most expensive per call.
            </span>
          </div>
          <Button onClick={trigger} className="gap-1.5">
            <Play className="size-3.5" /> Run backtest
          </Button>
        </div>
      </Panel>

      <Panel title="Recent runs" subtitle={`${BACKTEST_RUNS.length} runs total`} flush>
        <div className="p-3 space-y-2">
          {visible.map((run) => (
            <Collapsible key={run.id}>
              <div className={run.status === "running" ? "rounded-xl border border-blue-500/30 bg-blue-500/5" : "rounded-xl border border-border bg-card"}>
                <CollapsibleTrigger asChild>
                  <button className="w-full flex items-center gap-3 p-3 text-left">
                    <ChevronRight className="size-4 text-muted-foreground [[data-state=open]>&]:rotate-90 transition-transform" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{run.label ?? run.id}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">{run.id}</span>
                        <StatusBadge kind={run.status as "running" | "complete" | "failed"} />
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {run.tickers.join(" · ")} · {run.testStart.slice(0, 10)} → {run.testEnd.slice(0, 10)} · grace {run.graceDays}d
                      </div>
                    </div>
                    <div className="hidden sm:flex items-center gap-4 text-xs">
                      {run.status === "complete" && (
                        <>
                          <div>
                            <div className="text-muted-foreground">Signal ON</div>
                            <div className={run.signalOnReturn >= 0 ? "tabular text-emerald-500 font-medium" : "tabular text-red-500 font-medium"}>
                              {fmtPct(run.signalOnReturn)}
                            </div>
                          </div>
                          <div>
                            <div className="text-muted-foreground">Buy & hold</div>
                            <div className={run.buyHoldReturn >= 0 ? "tabular text-emerald-500 font-medium" : "tabular text-red-500 font-medium"}>
                              {fmtPct(run.buyHoldReturn)}
                            </div>
                          </div>
                          <div>
                            <div className="text-muted-foreground">Win rate</div>
                            <div className="tabular">{(run.winRate * 100).toFixed(0)}%</div>
                          </div>
                        </>
                      )}
                    </div>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-t border-border p-3 space-y-2">
                    {run.status === "complete" ? (
                      <>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          <MiniStats cols={4} items={[
                            { label: "Trades opened", value: String(run.tradesOpened) },
                            { label: "Trades closed", value: String(run.tradesClosed) },
                            { label: "Win rate", value: `${(run.winRate * 100).toFixed(0)}%` },
                            { label: "Created", value: fmtRelativeTime(run.createdAt) },
                          ]} />
                        </div>
                        <Button variant="outline" size="sm" onClick={() => openBacktest(run.id)} className="gap-1.5">
                          <FlaskConical className="size-3.5" /> View detail (equity curve + trades)
                        </Button>
                      </>
                    ) : (
                      <div className="text-sm text-muted-foreground">
                        Run in progress — phase updates appear here live every 1.5s.
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function BacktestDetail({
  run, onBack, onJumpToLlm,
}: {
  run?: BacktestRun;
  onBack: () => void;
  onJumpToLlm: () => void;
}) {
  if (!run) {
    return (
      <div className="space-y-4">
        <button onClick={onBack} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5">
          <ArrowLeft className="size-3.5" /> All runs
        </button>
        <Panel title="Run not found" subtitle="The requested run id does not exist">
          <div className="text-sm text-muted-foreground">The run may have been pruned. Go back and pick a run from the list.</div>
        </Panel>
      </div>
    );
  }

  const equity = buildEquityCurve(run.id, 90);
  const trades = run.id === "backtest-1784215" ? BACKTEST_TRADES : [];

  const cols: Column<BacktestTrade>[] = [
    { key: "ticker", header: "Ticker", mobileFullWidth: true, cell: (t) => <span className="font-medium">{t.ticker}</span>, rawValue: (t) => t.ticker },
    { key: "direction", header: "Dir", cell: (t) => <StatusBadge kind={t.direction} />, rawValue: (t) => t.direction },
    { key: "size", header: "Size", cell: (t) => <span className="tabular">{t.sizePct}%</span>, rawValue: (t) => t.sizePct },
    { key: "opened", header: "Opened", cell: (t) => <span className="text-xs text-muted-foreground">{fmtRelativeTime(t.opened)}</span>, rawValue: (t) => t.opened },
    { key: "closed", header: "Closed", cell: (t) => t.closed ? <span className="text-xs text-muted-foreground">{fmtRelativeTime(t.closed)}</span> : <span className="text-muted-foreground">open</span>, rawValue: (t) => t.closed },
    { key: "entry", header: "Entry", cell: (t) => <span className="tabular">${t.entry.toFixed(2)}</span>, rawValue: (t) => t.entry },
    { key: "exit", header: "Exit", cell: (t) => t.exit ? <span className="tabular">${t.exit.toFixed(2)}</span> : <span className="text-muted-foreground">—</span>, rawValue: (t) => t.exit },
    {
      key: "pnl", header: "P&L",
      cell: (t) => t.pnlPct == null ? <span className="text-muted-foreground">—</span> : (
        <span className={t.pnlPct >= 0 ? "text-emerald-500 tabular font-medium" : "text-red-500 tabular font-medium"}>{fmtPct(t.pnlPct)}</span>
      ),
      rawValue: (t) => t.pnlPct,
    },
    { key: "reason", header: "Exit", cell: (t) => <span className="text-xs capitalize">{t.closeReason.replace(/_/g, " ")}</span>, rawValue: (t) => t.closeReason },
    { key: "why", header: "Why", hideOnMobile: true, cell: (t) => <span className="text-xs text-muted-foreground line-clamp-2 max-w-xs">{t.why}</span>, rawValue: (t) => t.why },
  ];

  return (
    <div className="space-y-6">
      <button onClick={onBack} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5">
        <ArrowLeft className="size-3.5" /> All backtest runs
      </button>

      <PageHeader
        title={run.label ?? run.id}
        description={`${run.tickers.join(" · ")} · ${run.testStart.slice(0, 10)} → ${run.testEnd.slice(0, 10)} · grace ${run.graceDays}d`}
        actions={
          <>
            <StatusBadge kind={run.status as "running" | "complete" | "failed"} />
            <Button variant="outline" size="sm" onClick={onJumpToLlm} className="gap-1.5">
              View every LLM call this run made →
            </Button>
          </>
        }
      />

      <Panel title="Equity curve & positions opened" subtitle="Signal ON (solid) vs Buy & Hold (dashed)">
        <div className="space-y-4">
          <MiniStats
            cols={2}
            items={[
              { label: "Opened", value: String(run.tradesOpened) },
              { label: "Closed", value: String(run.tradesClosed) },
              { label: "Win rate", value: `${(run.winRate * 100).toFixed(0)}%`, accent: run.winRate >= 0.5 ? "emerald" : "red" },
              { label: "Signal ON return", value: fmtPct(run.signalOnReturn), accent: run.signalOnReturn >= 0 ? "emerald" : "red" },
              { label: "Buy & hold", value: fmtPct(run.buyHoldReturn), accent: run.buyHoldReturn >= 0 ? "emerald" : "red" },
              { label: "vs B&H alpha", value: fmtPct(run.signalOnReturn - run.buyHoldReturn), accent: run.signalOnReturn - run.buyHoldReturn >= 0 ? "emerald" : "red" },
            ]}
          />
          <EquityCurve data={equity} height={300} />
        </div>
      </Panel>

      <Panel title="Positions opened during this run" count={trades.length} flush>
        <div className="p-4">
          <DataTable columns={cols} rows={trades} filename={`${run.id}-trades`} />
        </div>
      </Panel>
    </div>
  );
}
