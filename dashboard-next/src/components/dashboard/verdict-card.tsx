"use client";

import { cn } from "@/lib/utils";
import { ShieldCheck, AlertTriangle, Scale, TrendingUp, Newspaper, MessageSquare, Activity } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { TradeDecision, AnalystOpinion } from "@/lib/types";
import { DirectionPill } from "./primitives";
import { fmtConfidence } from "@/lib/format";

const AGENT_META: Record<AnalystOpinion["agent"], { icon: LucideIcon; label: string; tone: string }> = {
  news_event: { icon: Newspaper, label: "News event", tone: "var(--info)" },
  sentiment: { icon: MessageSquare, label: "Sentiment", tone: "var(--info)" },
  price_impact: { icon: TrendingUp, label: "Price impact", tone: "var(--primary)" },
  technical: { icon: Activity, label: "Technical", tone: "var(--paused)" },
};

function AnalystLine({ op }: { op: AnalystOpinion }) {
  const meta = AGENT_META[op.agent];
  const Icon = meta.icon;
  return (
    <div className="flex gap-2 py-1.5">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: meta.tone }} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{meta.label}</span>
          {op.eventType && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{op.eventType}</span>
          )}
          {op.sentiment && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{op.sentiment}</span>
          )}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-foreground/90">{op.summary}</p>
        {op.justification && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{op.justification}</p>
        )}
      </div>
    </div>
  );
}

function DebateSide({
  side,
  label,
  tone,
}: {
  side: { argument: string; justification: string };
  label: string;
  tone: "long" | "short";
}) {
  return (
    <div
      className={cn(
        "flex-1 rounded-lg border p-3",
        tone === "long"
          ? "border-[color:var(--long)]/25 bg-[color:var(--long)]/5"
          : "border-[color:var(--short)]/25 bg-[color:var(--short)]/5",
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        {tone === "long" ? (
          <TrendingUp className="h-3 w-3 text-[color:var(--long)]" aria-hidden />
        ) : (
          <AlertTriangle className="h-3 w-3 text-[color:var(--short)]" aria-hidden />
        )}
        <span
          className={cn(
            "text-[10px] font-semibold uppercase tracking-wide",
            tone === "long" ? "text-[color:var(--long)]" : "text-[color:var(--short)]",
          )}
        >
          {label}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-foreground/90">{side.argument}</p>
      {side.justification && (
        <p className="mt-1.5 border-t border-border/50 pt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {side.justification}
        </p>
      )}
    </div>
  );
}

export function VerdictCard({
  decision,
  defaultOpen = false,
}: {
  decision: TradeDecision;
  defaultOpen?: boolean;
}) {
  const d = decision.debate;
  const priceImpact = decision.opinions.find((o) => o.agent === "price_impact");
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card card-hairline">
      {/* Analyst opinions — top strip */}
      <div className="border-b border-border bg-muted/20 px-4 py-2">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Analyst team
        </p>
        <div className="divide-y divide-border/60">
          {decision.opinions.map((op, i) => (
            <AnalystLine key={i} op={op} />
          ))}
        </div>
      </div>

      {!d ? (
        <div className="p-4">
          <div className="rounded-lg border-l-[3px] bg-muted/40 px-3 py-2.5" style={{ borderLeftColor: "var(--muted-foreground)" }}>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Skipped before debate
            </span>
            <p className="mt-1.5 text-xs leading-relaxed text-foreground/90">
              {priceImpact?.justification || priceImpact?.summary || decision.portfolioDecision?.reason || "Filtered out by the price-impact gate; no Bull/Bear debate was run."}
            </p>
          </div>
        </div>
      ) : (
      <div className="p-4">
        <div className="mb-3 flex items-center gap-1.5">
          <Scale className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Bull / Bear debate
          </span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <DebateSide side={d.bull} label="Bull" tone="long" />
          <DebateSide side={d.bear} label="Bear" tone="short" />
        </div>

        {/* Verdict spine */}
        <div
          className="mt-3 rounded-lg border-l-[3px] bg-muted/40 px-3 py-2.5"
          style={{ borderLeftColor: "var(--primary)" }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[color:var(--primary)]" aria-hidden />
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Verdict
              </span>
            </div>
            <div className="flex items-center gap-2">
              <DirectionPill direction={d.direction} size="sm" />
              <span className="font-mono text-sm font-semibold nums">
                {fmtConfidence(d.confidence)}
              </span>
            </div>
          </div>
          <p className="mt-1.5 font-display text-sm italic leading-relaxed text-foreground/90">
            &ldquo;{d.justification}&rdquo;
          </p>
          {d.timeHorizon && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Horizon: <span className="font-mono">{d.timeHorizon}</span>
            </p>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

/** Compact verdict summary — used in lists / detail rows */
export function VerdictSummary({ decision }: { decision: TradeDecision }) {
  const d = decision.debate;
  if (!d) {
    return <span className="text-xs text-muted-foreground">No debate</span>;
  }
  return (
    <div className="flex items-center gap-2">
      <DirectionPill direction={d.direction} size="sm" />
      <span className="font-mono text-xs nums text-muted-foreground">
        {fmtConfidence(d.confidence)}
      </span>
    </div>
  );
}
