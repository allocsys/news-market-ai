"use client";

import { useState, useMemo } from "react";
import { useDash } from "@/lib/dash/store";
import { LLM_CALLS, fmtRelativeTime } from "@/lib/dash/mock-data";
import { Panel, PageHeader, FilterPills } from "../shared/primitives";
import { StatusBadge } from "../shared/status-badge";
import { DataTable, type Column } from "../shared/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  BrainCircuit, ChevronLeft, ChevronRight, AlertTriangle,
} from "lucide-react";
import type { LlmCall } from "@/lib/dash/types";

const SOURCE_PILLS = [
  { value: "all", label: "All sources" },
  { value: "pipeline", label: "Pipeline" },
  { value: "backtest", label: "Backtest" },
  { value: "exit_check", label: "Exit check" },
];

const STATUS_PILLS = [
  { value: "all", label: "All" },
  { value: "ok", label: "OK" },
  { value: "error", label: "Error" },
];

const ROW_PILLS = [
  { value: "25", label: "25" },
  { value: "50", label: "50" },
  { value: "100", label: "100" },
];

export function LlmCallsView() {
  const tickerFilter = useDash((s) => s.tickerFilter);
  const tick = tickerFilter;
  const llmDetailId = useDash((s) => s.llmDetailId);
  const openLlm = useDash((s) => s.openLlm);

  const [source, setSource] = useState("all");
  const [status, setStatus] = useState("all");
  const [rows, setRows] = useState("25");
  const [tickerInput, setTickerInput] = useState("");
  const [cursor, setCursor] = useState(0); // cursor offset

  const filtered = useMemo(() => {
    let list = LLM_CALLS;
    if (tick) list = list.filter((c) => c.ticker === tick);
    if (tickerInput.trim()) {
      const q = tickerInput.trim().toUpperCase();
      list = list.filter((c) => c.ticker.includes(q));
    }
    if (source !== "all") list = list.filter((c) => c.source === source);
    if (status !== "all") list = list.filter((c) => c.status === status);
    return list;
  }, [tick, tickerInput, source, status]);

  const rowsPerPage = parseInt(rows, 10);
  const pageRows = filtered.slice(cursor, cursor + rowsPerPage);
  const hasOlder = cursor + rowsPerPage < filtered.length;
  const hasNewer = cursor > 0;

  const selected = llmDetailId ? LLM_CALLS.find((c) => c.id === llmDetailId) : null;

  const cols: Column<LlmCall>[] = [
    {
      key: "ticker", header: "Ticker / Agent", mobileFullWidth: true,
      cell: (c) => (
        <div className="min-w-0">
          <div className="font-medium">{c.ticker}</div>
          <div className="text-[10px] font-mono text-muted-foreground">{c.agent}</div>
        </div>
      ),
      rawValue: (c) => c.ticker,
    },
    {
      key: "source", header: "Source",
      cell: (c) => <span className="text-xs capitalize">{c.source.replace(/_/g, " ")}</span>,
      rawValue: (c) => c.source,
    },
    {
      key: "status", header: "Status",
      cell: (c) => <StatusBadge kind={c.status} />,
      rawValue: (c) => c.status,
    },
    {
      key: "model", header: "Model",
      cell: (c) => (
        <div className="min-w-0">
          <div className="font-mono text-xs">{c.answeredBy}</div>
          {c.fellBackFrom && (
            <div className="flex items-center gap-1 text-[10px] text-amber-500 mt-0.5">
              <AlertTriangle className="size-2.5" /> fell back from {c.fellBackFrom}
            </div>
          )}
        </div>
      ),
      rawValue: (c) => c.answeredBy,
    },
    {
      key: "took", header: "Took",
      cell: (c) => <span className="tabular text-xs">{(c.tookMs / 1000).toFixed(2)}s</span>,
      rawValue: (c) => c.tookMs,
    },
    {
      key: "when", header: "When",
      cell: (c) => <span className="text-xs text-muted-foreground tabular">{fmtRelativeTime(c.when)}</span>,
      rawValue: (c) => c.when,
    },
    {
      key: "sent", header: "Sent (preview)", hideOnMobile: true,
      cell: (c) => <span className="text-xs text-muted-foreground line-clamp-1 max-w-xs font-mono">{c.promptPreview}</span>,
      rawValue: (c) => c.promptPreview,
    },
    {
      key: "got", header: "Got back (preview)", hideOnMobile: true,
      cell: (c) => <span className="text-xs text-muted-foreground line-clamp-1 max-w-xs font-mono">{c.responsePreview}</span>,
      rawValue: (c) => c.responsePreview,
    },
    {
      key: "detail", header: "",
      cell: (c) => (
        <Button variant="ghost" size="sm" onClick={() => openLlm(c.id)} className="h-7 px-2 text-xs">
          Detail →
        </Button>
      ),
      className: "text-right",
      hideOnMobile: true,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={tick ? `LLM Calls · ${tick}` : "LLM Calls"}
        description="Every Gemini call the pipeline made, with cascade-attempts table and full prompt/response. Use the filters to scope to one source, status, or ticker."
        actions={
          <>
            <FilterPills pills={SOURCE_PILLS} value={source} onChange={setSource} ariaLabel="Source filter" />
            <FilterPills pills={STATUS_PILLS} value={status} onChange={setStatus} ariaLabel="Status filter" />
            <FilterPills pills={ROW_PILLS} value={rows} onChange={setRows} ariaLabel="Rows per page" />
          </>
        }
      />

      <Panel title="Filters" subtitle="Combine ticker text input with source / status / rows pills">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label htmlFor="ticker-filter" className="text-xs">Ticker filter</Label>
            <Input
              id="ticker-filter"
              value={tickerInput}
              onChange={(e) => {
                const v = e.target.value.toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
                setTickerInput(v);
                setCursor(0);
              }}
              placeholder="e.g. AAPL"
              maxLength={12}
              autoCapitalize="characters"
              className="h-9 mt-1 font-mono uppercase text-xs"
            />
            <div className="text-[10px] text-muted-foreground mt-1">Regex: ^[A-Z0-9.-]{"{1,12}"}$</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Matches</div>
            <div className="text-lg font-semibold tabular mt-1">{filtered.length}</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Error rate</div>
            <div className="text-lg font-semibold tabular mt-1 text-amber-500">
              {filtered.length ? Math.round((filtered.filter((c) => c.status === "error").length / filtered.length) * 100) : 0}%
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Call log" subtitle="Cursor-paged newest-first" count={filtered.length} flush>
        <div className="p-4 space-y-3">
          {pageRows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card/30 py-12 px-6 text-center">
              <BrainCircuit className="size-6 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm font-medium">No LLM calls match this filter.</p>
              <p className="text-xs text-muted-foreground mt-1">Try clearing the ticker input or status filter.</p>
            </div>
          ) : (
            <DataTable columns={cols} rows={pageRows} filename={`llm-calls${tick ? `-${tick}` : ""}`} />
          )}
          <div className="flex items-center justify-between pt-2">
            <div className="text-xs text-muted-foreground tabular">
              Showing {cursor + 1}–{Math.min(cursor + rowsPerPage, filtered.length)} of {filtered.length}
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                disabled={!hasNewer}
                onClick={() => setCursor(Math.max(0, cursor - rowsPerPage))}
                className="h-8 gap-1.5"
              >
                <ChevronLeft className="size-3.5" /> Newer
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasOlder}
                onClick={() => setCursor(cursor + rowsPerPage)}
                className="h-8 gap-1.5"
              >
                Older <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </Panel>

      <Dialog open={!!selected} onOpenChange={(o) => !o && openLlm(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto scroll-thin">
          <DialogHeader>
            <DialogTitle className="font-mono text-base flex items-center gap-2">
              <BrainCircuit className="size-4" />
              {selected?.id}
              {selected && <StatusBadge kind={selected.status} />}
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <Meta label="Ticker" value={selected.ticker} />
                <Meta label="Source" value={selected.source} />
                <Meta label="Requested" value={selected.requestedModel} mono />
                <Meta label="Answered by" value={selected.answeredBy} mono />
                <Meta label="Took" value={`${(selected.tookMs / 1000).toFixed(2)}s`} />
                <Meta label="When" value={fmtRelativeTime(selected.when)} />
                <Meta label="Prompt tokens" value={selected.promptTokens.toLocaleString()} />
                <Meta label="Response tokens" value={selected.responseTokens.toLocaleString()} />
              </div>

              {selected.fellBackFrom && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs flex items-start gap-2">
                  <AlertTriangle className="size-3.5 text-amber-500 shrink-0 mt-0.5" />
                  <span className="text-amber-700 dark:text-amber-300">
                    Cascade fell back from <strong>{selected.fellBackFrom}</strong> to <strong>{selected.answeredBy}</strong>.
                  </span>
                </div>
              )}

              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Cascade attempts</div>
                <div className="rounded-lg border border-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">#</th>
                        <th className="px-2 py-1.5 text-left">Model</th>
                        <th className="px-2 py-1.5 text-left">Key</th>
                        <th className="px-2 py-1.5 text-left">Outcome</th>
                        <th className="px-2 py-1.5 text-left">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.cascade.map((c, i) => (
                        <tr key={i} className="border-t border-border/60">
                          <td className="px-2 py-1.5 tabular">{i + 1}</td>
                          <td className="px-2 py-1.5 font-mono">{c.model}</td>
                          <td className="px-2 py-1.5 font-mono text-muted-foreground">{c.key}</td>
                          <td className="px-2 py-1.5"><StatusBadge kind={c.outcome === "ok" ? "ok" : "error"} /></td>
                          <td className="px-2 py-1.5 text-muted-foreground">{c.detail ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Prompt</div>
                <pre className="text-xs bg-muted/30 border border-border rounded-lg p-3 overflow-auto max-h-64 whitespace-pre-wrap break-words font-mono">
                  {selected.promptPreview}
                </pre>
              </div>

              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Response</div>
                <pre className="text-xs bg-muted/30 border border-border rounded-lg p-3 overflow-auto max-h-64 whitespace-pre-wrap break-words font-mono">
                  {selected.responsePreview}
                </pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-sm font-medium mt-0.5 ${mono ? "font-mono" : ""} truncate`}>{value}</div>
    </div>
  );
}
