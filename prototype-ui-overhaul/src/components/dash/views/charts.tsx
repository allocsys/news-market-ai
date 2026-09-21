"use client";

import { useDash } from "@/lib/dash/store";
import { TICKERS } from "@/lib/dash/mock-data";
import { Panel, PageHeader } from "../shared/primitives";
import { Sparkline } from "../shared/sparkline";
import { cn } from "@/lib/utils";

export function ChartsView() {
  const setTickerFilter = useDash((s) => s.setTickerFilter);
  const tickerFilter = useDash((s) => s.tickerFilter);
  const tick = tickerFilter;
  const list = tick ? TICKERS.filter((t) => t.symbol === tick) : TICKERS.slice(0, 8);

  return (
    <div className="space-y-6">
      <PageHeader
        title={tick ? `Charts · ${tick}` : "Charts"}
        description="Price sparklines for the currently open universe. NOT point-in-time gated — shows current price for currently-open positions. Click any cell to filter the whole dashboard by that ticker."
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 md:gap-4">
        {list.map((t) => {
          const up = t.changePct >= 0;
          return (
            <button
              key={t.symbol}
              onClick={() => setTickerFilter(t.symbol)}
              className={cn(
                "group rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/30",
                tick === t.symbol && "border-primary/40 bg-primary/5"
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="font-semibold tracking-tight">{t.symbol}</div>
                  <div className="text-xs text-muted-foreground truncate">{t.name}</div>
                </div>
                <div className={cn(
                  "text-xs tabular font-medium px-1.5 py-0.5 rounded",
                  up ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10" : "text-red-600 dark:text-red-400 bg-red-500/10"
                )}>
                  {up ? "+" : ""}{t.changePct.toFixed(2)}%
                </div>
              </div>
              <Sparkline data={t.sparkline} width={240} height={64} />
              <div className="mt-2 flex items-center justify-between text-xs">
                <span className="tabular font-medium">${t.price.toFixed(2)}</span>
                <span className="text-muted-foreground text-[10px]">30d</span>
              </div>
            </button>
          );
        })}
      </div>

      <Panel title="Notes on price source" subtitle="Read this before relying on these prices">
        <div className="space-y-2 text-sm text-muted-foreground leading-relaxed max-w-2xl">
          <p>
            These sparklines are sourced from Tiingo end-of-day bars. They are <strong className="text-foreground">not</strong> point-in-time gated:
            for currently-open positions, the chart shows the <em>current</em> price, not the price as of the decision date.
          </p>
          <p>
            For point-in-time-correct equity curves, see the <strong className="text-foreground">Backtest</strong> view's per-run equity chart —
            that one is computed from fractional daily returns inside the simulation window.
          </p>
        </div>
      </Panel>
    </div>
  );
}
