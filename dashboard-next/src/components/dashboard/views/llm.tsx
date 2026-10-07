"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Filter,
  ChevronRight,
  ChevronLeft,
  AlertTriangle,
  Clock,
  Cpu,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";
import { useLlmCalls, useLlmCallDetail } from "@/lib/api";
import { SectionHeading, Pill, StatusBadge, EmptyState, ErrorState } from "../primitives";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  fmtRelative,
  fmtDuration,
  fmtTime,
  truncate,
} from "@/lib/format";
import type { ViewProps } from "./types";

const SOURCES = ["all", "pipeline", "backtest", "exit_check", "replay"] as const;
const STATUSES = ["all", "ok", "error"] as const;
const LIMITS = [25, 50, 100];

export function LlmView({ tickerFilter, onNavigate, env }: ViewProps & { tickerFilter?: string }) {
  const [source, setSource] = useState<(typeof SOURCES)[number]>("all");
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("all");
  const [limit, setLimit] = useState(50);
  const [filtersOpen, setFiltersOpen] = useState(Boolean(tickerFilter));
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Paging: each "Older" push remembers the cursor (nextBeforeId) of the page being left; "Newest" clears the stack. The last entry is the current page's `llmBefore`.
  // The stack is tagged with the filter scope it was built under, so a different filter or environment starts again from the newest call without an effect.
  const scope = `${env ?? "live"}|${source}|${status}|${limit}|${tickerFilter ?? ""}`;
  const [paging, setPaging] = useState<{ scope: string; stack: number[] }>({ scope, stack: [] });
  const cursors = paging.scope === scope ? paging.stack : [];
  const llmBefore = cursors.length > 0 ? cursors[cursors.length - 1] : null;
  const calls = useLlmCalls({
    env,
    llmSource: source === "all" ? undefined : source,
    llmStatus: status === "all" ? undefined : status,
    llmLimit: limit,
    llmTicker: tickerFilter,
    llmBefore,
  });
  const nextBeforeId = calls.data?.nextBeforeId ?? null;

  const detail = useLlmCallDetail(selectedId, env);

  return (
    <div className="space-y-5">
      {/* Filters */}
      <Collapsible open={filtersOpen} onOpenChange={setFiltersOpen}>
        <div className="rounded-xl border border-border bg-card">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm"
            >
              <Filter className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <span className="font-medium">Filters</span>
              {(source !== "all" || status !== "all" || tickerFilter) && (
                <Pill tone="info" size="sm">
                  {source !== "all" ? source : "any source"}
                  {status !== "all" ? ` · ${status}` : ""}
                  {tickerFilter ? ` · ${tickerFilter}` : ""}
                </Pill>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {calls.data?.calls.length ?? 0} shown
              </span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-3 border-t border-border p-4">
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Source</p>
                <div className="no-scrollbar flex flex-wrap gap-1">
                  {SOURCES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setSource(s)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                        source === s
                          ? "border-primary bg-primary/15 text-primary"
                          : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {s === "all" ? "All" : s.replace("_", " ")}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Status</p>
                <div className="flex gap-1">
                  {STATUSES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setStatus(s)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                        status === s
                          ? "border-primary bg-primary/15 text-primary"
                          : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {s === "all" ? "All" : s}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Rows</p>
                <div className="flex items-center gap-1">
                  {LIMITS.map((l) => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => setLimit(l)}
                      className={cn(
                        "rounded-md border px-2.5 py-1 font-mono text-xs nums transition-colors",
                        limit === l
                          ? "border-primary bg-primary/15 text-primary"
                          : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {l}
                    </button>
                  ))}
                  {tickerFilter && (
                    <button
                      type="button"
                      onClick={() => onNavigate("llm")}
                      className="ml-auto text-xs text-primary hover:underline"
                    >
                      Clear ticker filter
                    </button>
                  )}
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      {/* Note about backtest env */}
      <div className="flex items-start gap-2 rounded-lg border border-[color:var(--info)]/25 bg-[color:var(--info)]/8 px-3 py-2.5 text-xs">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--info)]" aria-hidden />
        <p className="text-muted-foreground">
          Backtests don&apos;t log by default. Enable LLM logging per run via the Backtest form to inspect prompts.
        </p>
      </div>

      {/* List */}
      <section>
        <SectionHeading title="Calls" description="Newest first" />
        {calls.isLoading ? (
          <div className="mt-3 flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading calls…
          </div>
        ) : calls.isError ? (
          <div className="mt-3">
            <ErrorState message={calls.error?.message ?? "Failed to load LLM calls"} />
          </div>
        ) : !calls.data || calls.data.calls.length === 0 ? (
          <div className="mt-3">
            <EmptyState icon={Cpu} title="No LLM calls match" message="Try widening filters." />
          </div>
        ) : (
          <ul className="mt-3 space-y-2">
            {calls.data.calls.map((c, i) => (
              <li key={c.id} className="animate-fade-up" style={{ animationDelay: `${i * 25}ms` }}>
                <button
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className="block w-full overflow-hidden rounded-xl border border-border bg-card text-left card-hairline transition-colors hover:bg-accent/40"
                >
                  <div className="flex items-start gap-3 p-3">
                    <div className="mt-0.5">
                      {c.status === "ok" ? (
                        <CheckCircle2 className="h-4 w-4 text-[color:var(--long)]" />
                      ) : (
                        <XCircle className="h-4 w-4 text-[color:var(--short)]" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{c.ticker ?? "—"}</span>
                        <span className="text-sm text-foreground/90">{c.label}</span>
                        <Pill tone="info" size="sm">{c.source}</Pill>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {c.promptPreview}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-0.5">
                          <Clock className="h-2.5 w-2.5" />
                          {fmtRelative(c.createdAt)}
                        </span>
                        <span className="font-mono">
                          {c.modelUsed ?? "—"}
                          {c.modelUsed && c.requestedModel && c.modelUsed !== c.requestedModel && (
                            <span className="text-[color:var(--paused)]"> ↓{truncate(c.requestedModel, 20)}</span>
                          )}
                        </span>
                        <span className="font-mono nums">{fmtDuration(c.durationMs)}</span>
                        <span className="font-mono nums">#{c.id}</span>
                      </div>
                    </div>
                    <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Pager */}
      {(cursors.length > 0 || nextBeforeId != null) && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setPaging({ scope, stack: [] })}
            disabled={cursors.length === 0}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="h-3 w-3" /> Newest
          </button>
          <span className="text-xs text-muted-foreground">page {cursors.length + 1}</span>
          <button
            type="button"
            onClick={() => nextBeforeId != null && setPaging({ scope, stack: [...cursors, nextBeforeId] })}
            disabled={nextBeforeId == null}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            Older <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Detail drawer (right side on desktop, full sheet on mobile) */}
      <Sheet open={selectedId != null} onOpenChange={(v) => !v && setSelectedId(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          {detail.isLoading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading call…
            </div>
          )}
          {detail.isError && <ErrorState message={detail.error?.message ?? "Failed to load call"} />}
          {detail.data && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2 font-mono">
                  <span className="text-base">#{detail.data.id}</span>
                  <span className="text-base">{detail.data.ticker ?? "—"}</span>
                  <Pill tone={detail.data.status === "ok" ? "long" : "short"} size="sm">{detail.data.status}</Pill>
                </SheetTitle>
                <SheetDescription>{detail.data.label}</SheetDescription>
              </SheetHeader>

              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <MetaRow label="When" value={fmtTime(detail.data.createdAt)} />
                  <MetaRow label="Source" value={detail.data.source} />
                  <MetaRow label="Ticker" value={detail.data.ticker ?? "—"} />
                  <MetaRow label="Requested" value={detail.data.requestedModel ?? "—"} mono />
                  <MetaRow label="Answered by" value={detail.data.modelUsed ?? "—"} mono />
                  <MetaRow label="Took" value={fmtDuration(detail.data.durationMs)} mono />
                  <MetaRow label="Prompt chars" value={String(detail.data.promptChars)} mono />
                  <MetaRow label="Response chars" value={String(detail.data.responseChars)} mono />
                </div>

                {detail.data.attempts && detail.data.attempts.length > 0 && (
                  <div>
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Cascade attempts
                    </p>
                    <div className="overflow-hidden rounded-lg border border-border">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/40">
                          <tr>
                            <th className="px-2 py-1.5 text-left">#</th>
                            <th className="px-2 py-1.5 text-left">Model</th>
                            <th className="px-2 py-1.5 text-left">Key</th>
                            <th className="px-2 py-1.5 text-left">Outcome</th>
                            <th className="px-2 py-1.5 text-left">Detail</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {detail.data.attempts.map((a, i) => (
                            <tr key={i}>
                              <td className="px-2 py-1.5 font-mono nums">{i + 1}</td>
                              <td className="px-2 py-1.5 font-mono">{a.model}</td>
                              <td className="px-2 py-1.5 font-mono nums">{a.keyIndex ?? "—"}</td>
                              <td className="px-2 py-1.5">
                                <Pill
                                  tone={a.outcome === "ok" ? "long" : a.outcome === "error" ? "short" : "muted"}
                                  size="sm"
                                >
                                  {a.outcome}
                                </Pill>
                              </td>
                              <td className="px-2 py-1.5 text-muted-foreground">{truncate(a.detail, 40)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {detail.data.error && (
                  <div className="rounded-lg border border-[color:var(--short)]/30 bg-[color:var(--short)]/8 p-3 text-xs">
                    <p className="font-medium text-[color:var(--short)]">Error</p>
                    <p className="mt-0.5 text-muted-foreground">{detail.data.error}</p>
                    {detail.data.errorStage && (
                      <p className="mt-1 text-[10px] text-muted-foreground">Stage: {detail.data.errorStage}</p>
                    )}
                  </div>
                )}

                <div>
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Prompt ({detail.data.promptChars} chars)
                  </p>
                  <pre className="max-h-72 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words">
                    {detail.data.prompt}
                  </pre>
                </div>

                {detail.data.response && (
                  <div>
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Response ({detail.data.responseChars} chars)
                    </p>
                    <pre className="max-h-72 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words">
                      {detail.data.response}
                    </pre>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 truncate text-foreground/90", mono && "font-mono nums text-[11px]")}>
        {value}
      </div>
    </div>
  );
}
