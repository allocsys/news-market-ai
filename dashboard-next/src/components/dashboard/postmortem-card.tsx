"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtPct, signedPct } from "@/lib/format";
import {
  useBacktestRuns,
  usePostmortem,
  usePostmortemCompare,
  type PostmortemGroup,
  type PostmortemResponse,
  type PostmortemStage,
  type PostmortemTag,
} from "@/lib/api";
import { Pill, SectionHeading, MiniStat, ErrorState } from "./primitives";

type Tone = "approved" | "rejected" | "info" | "muted" | "neutral-pos";

const TAGS: Record<PostmortemTag, { label: string; tone: Tone; hint: string }> = {
  win: { label: "Win", tone: "approved", hint: "Closed with a positive return." },
  loss_flip: { label: "Closed by a flip", tone: "rejected", hint: "Closed at a loss by an opposite (or replacing) thesis." },
  loss_stop_pre_empted: {
    label: "Stop pre-empted",
    tone: "rejected",
    hint: "The stop level was breached before a flip closed it, which then filled worse.",
  },
  loss_wrong_from_start: { label: "Wrong from the start", tone: "rejected", hint: "Stopped out and never meaningfully in profit." },
  loss_reversed: { label: "Reversed", tone: "rejected", hint: "Was in profit, then stopped out." },
  loss_time_exit: { label: "Time exit", tone: "rejected", hint: "Hold limit reached at a loss." },
  loss_other: { label: "Loss", tone: "rejected", hint: "Closed at a loss for another reason." },
  open: { label: "Open", tone: "info", hint: "Still open." },
  no_return: { label: "No return", tone: "muted", hint: "Closed without a usable exit price." },
};

const STAGES: Record<PostmortemStage, string> = {
  analyst: "Analyst (price impact)",
  debate: "Debate",
  trader: "Trader",
  unknown: "Unknown",
};

const OUTCOMES: Record<string, string> = {
  missed_winner: "Missed winner",
  good_skip: "Good skip",
  inconclusive: "Inconclusive",
  no_data: "No price data",
};

function tagLabel(key: string) {
  return TAGS[key as PostmortemTag]?.label ?? key.replace(/_/g, " ");
}

/** Small pill for a post-mortem tag (used on position cards). */
export function PostmortemTagPill({ tag, stage }: { tag: PostmortemTag; stage?: PostmortemStage | null }) {
  const t = TAGS[tag];
  if (!t) return null;
  const blame = stage && stage !== "unknown" ? ` · ${stage}` : "";
  return (
    <span title={t.hint}>
      <Pill tone={t.tone} size="sm">
        {t.label}
        {blame}
      </Pill>
    </span>
  );
}

function retClass(x: number) {
  return x > 0 ? "text-[color:var(--long)]" : x < 0 ? "text-[color:var(--short)]" : "text-muted-foreground";
}

function GroupTable({ title, rows, label }: { title: string; rows: PostmortemGroup[]; label?: (k: string) => string }) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <h3 className="text-xs font-semibold">{title}</h3>
      <table className="mt-2 w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
            <th className="py-1 pr-2 font-medium" />
            <th className="px-1 py-1 text-right font-medium">n</th>
            <th className="px-1 py-1 text-right font-medium">Win</th>
            <th className="px-1 py-1 text-right font-medium">Avg</th>
            <th className="py-1 pl-1 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.key} className="border-t border-border/60">
              <td className="py-1 pr-2">{label ? label(g.key) : g.key}</td>
              <td className="px-1 py-1 text-right font-mono nums">{g.n}</td>
              <td className="px-1 py-1 text-right font-mono nums">{fmtPct(g.winRate, 0)}</td>
              <td className={cn("px-1 py-1 text-right font-mono nums", retClass(g.avgReturn))}>{signedPct(g.avgReturn, 1)}</td>
              <td className={cn("py-1 pl-1 text-right font-mono font-medium nums", retClass(g.sumReturn))}>{signedPct(g.sumReturn, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MissedBlock({ pm }: { pm: PostmortemResponse }) {
  const m = pm.missed;
  if (pm.missedError) return <ErrorState message={`Missed-opportunity check failed: ${pm.missedError}`} />;
  if (!m) return null;
  if (m.total === 0) {
    return <p className="text-xs text-muted-foreground">No held or rejected decisions carried a long/short thesis.</p>;
  }
  const outcomes = ["missed_winner", "good_skip", "inconclusive", "no_data"];
  return (
    <div className="space-y-2">
      <div className="rounded-xl border border-border bg-card p-3">
        <h3 className="text-xs font-semibold">Held / rejected decisions: what the price did next</h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {m.horizonHours}h look-ahead after each decision, using that decision&apos;s own stop and target (a bar touching both counts as stop-first). A
          post-hoc audit only, never an input to a run.
        </p>
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="py-1 pr-2 font-medium" />
              {outcomes.map((o) => (
                <th key={o} className="px-1 py-1 text-right font-medium">
                  {OUTCOMES[o]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(m.byStatus).map(([status, counts]) => (
              <tr key={status} className="border-t border-border/60">
                <td className="py-1 pr-2 capitalize">{status.replace(/_/g, " ")}</td>
                {outcomes.map((o) => (
                  <td key={o} className="px-1 py-1 text-right font-mono nums">
                    {counts[o] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {m.barsTruncated && <p className="mt-2 text-[11px] text-[color:var(--paused)]">Price bars hit the read cap; later decisions may show &quot;No price data&quot;.</p>}
      </div>
      {m.missedWinners.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-3">
          <h3 className="text-xs font-semibold">Missed winners</h3>
          <ul className="mt-2 space-y-1 text-xs">
            {m.missedWinners.slice(0, 8).map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-x-2">
                <span className="font-mono font-medium">{w.ticker}</span>
                <span className="capitalize text-muted-foreground">{w.direction}</span>
                <span className="text-muted-foreground">{w.status.replace(/_/g, " ")}</span>
                <span className="font-mono nums text-muted-foreground">{w.asOf.slice(0, 16).replace("T", " ")}</span>
                {w.forwardMovePct != null && <span className="font-mono nums text-[color:var(--long)]">{signedPct(w.forwardMovePct, 1)}</span>}
                {w.hoursToHit != null && <span className="font-mono nums text-muted-foreground">in {w.hoursToHit.toFixed(0)}h</span>}
              </li>
            ))}
          </ul>
          {m.missedWinners.length > 8 && <p className="mt-1 text-[11px] text-muted-foreground">+{m.missedWinners.length - 8} more</p>}
        </div>
      )}
    </div>
  );
}

function CompareBlock({ runId, otherId }: { runId: string; otherId: string }) {
  const q = usePostmortemCompare(runId, otherId);
  if (q.isLoading) {
    return (
      <div className="flex items-center py-4 text-xs text-muted-foreground">
        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
        Comparing…
      </div>
    );
  }
  if (q.isError || !q.data) return <ErrorState message={q.error?.message ?? "Comparison failed"} />;
  const { a, b, comparison: c } = q.data;
  const rows: { label: string; a: string; b: string }[] = [
    { label: "Positions", a: String(a.summary.n), b: String(b.summary.n) },
    { label: "Win rate", a: a.summary.winRate == null ? "—" : fmtPct(a.summary.winRate, 0), b: b.summary.winRate == null ? "—" : fmtPct(b.summary.winRate, 0) },
    { label: "Total return", a: signedPct(a.summary.sumReturn, 1), b: signedPct(b.summary.sumReturn, 1) },
    { label: "Opened", a: String(a.statusCounts.opened ?? 0), b: String(b.statusCounts.opened ?? 0) },
    { label: "Held", a: String(a.statusCounts.held ?? 0), b: String(b.statusCounts.held ?? 0) },
    { label: "Rejected", a: String(a.statusCounts.rejected ?? 0), b: String(b.statusCounts.rejected ?? 0) },
  ];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MiniStat value={c.matched} label="Same decisions" sub={`A ${c.aDecisions} · B ${c.bDecisions}`} />
        <MiniStat value={c.directionAgreement == null ? "—" : fmtPct(c.directionAgreement, 0)} label="Same direction" sub={`${c.sameDirection} of ${c.matched}`} />
        <MiniStat value={c.statusAgreement == null ? "—" : fmtPct(c.statusAgreement, 0)} label="Same outcome" sub={`${c.sameStatus} of ${c.matched}`} />
        <MiniStat
          value={c.avgConfidenceDeltaBMinusA == null ? "—" : `${c.avgConfidenceDeltaBMinusA >= 0 ? "+" : ""}${c.avgConfidenceDeltaBMinusA.toFixed(2)}`}
          label="Confidence B−A"
          sub="same decisions"
        />
      </div>
      <div className="rounded-xl border border-border bg-card p-3">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="py-1 pr-2 font-medium" />
              <th className="px-1 py-1 text-right font-medium">This run (A)</th>
              <th className="py-1 pl-1 text-right font-medium">Other (B)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-t border-border/60">
                <td className="py-1 pr-2">{r.label}</td>
                <td className="px-1 py-1 text-right font-mono nums">{r.a}</td>
                <td className="py-1 pl-1 text-right font-mono nums">{r.b}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <GroupTable title="A: by outcome" rows={a.summary.byTag} label={tagLabel} />
        <GroupTable title="B: by outcome" rows={b.summary.byTag} label={tagLabel} />
      </div>
    </div>
  );
}

export function PostmortemCard({ runId }: { runId: string }) {
  const pm = usePostmortem(runId);
  const runs = useBacktestRuns();
  const [otherId, setOtherId] = useState("");

  if (pm.isLoading) {
    return (
      <section>
        <SectionHeading title="Post-mortem" description="Where each position's outcome came from" />
        <div className="mt-3 flex items-center text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          Analysing…
        </div>
      </section>
    );
  }
  if (pm.isError || !pm.data) {
    return (
      <section>
        <SectionHeading title="Post-mortem" description="Where each position's outcome came from" />
        <div className="mt-3">
          <ErrorState message={pm.error?.message ?? "Post-mortem failed to load"} />
        </div>
      </section>
    );
  }

  const d = pm.data;
  const s = d.summary;
  const others = (runs.data?.backtestRuns ?? []).filter((r) => r.id !== runId && r.status === "complete");

  return (
    <section>
      <SectionHeading title="Post-mortem" description="Where each position's outcome came from (computed on read; small samples are hints, not proof)" />
      {s.scored === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">No closed position with a return yet.</p>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniStat value={s.scored} label="Scored" sub={`${s.open} still open`} />
            <MiniStat value={s.winRate == null ? "—" : fmtPct(s.winRate, 0)} label="Win rate" />
            <MiniStat value={signedPct(s.sumReturn, 1)} label="Sum of returns" sub="net of costs" />
            <MiniStat value={s.stagesAlwaysAgreed ? "Yes" : "No"} label="Stages always agreed" sub="analyst = debate = thesis" />
          </div>
          {s.stagesAlwaysAgreed && (
            <p className="text-[11px] text-muted-foreground">
              Every stage pointed the same way on every scored trade, so the debate added no independent signal on the trades that opened.
            </p>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <GroupTable title="By outcome" rows={s.byTag} label={tagLabel} />
            <GroupTable title="Losses: first stage to call the losing direction" rows={s.byLossStage} label={(k) => STAGES[k as PostmortemStage] ?? k} />
            <GroupTable title="By close reason" rows={s.byCloseReason} label={(k) => k.replace(/_/g, " ")} />
            <GroupTable title="By analyst relevance" rows={s.byRelevance} />
            <GroupTable title="By debate confidence" rows={s.byConfidence} />
          </div>
        </div>
      )}

      {(d.positionsTruncated || d.decisionsTruncated || d.positionsError || d.decisionsError) && (
        <p className="mt-2 text-[11px] text-[color:var(--paused)]">
          {[
            d.positionsTruncated && "positions truncated",
            d.decisionsTruncated && "decisions truncated",
            d.positionsError && `positions: ${d.positionsError}`,
            d.decisionsError && `decisions: ${d.decisionsError}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}

      <div className="mt-4">
        <MissedBlock pm={d} />
      </div>

      <div className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-semibold">Compare with another run</h3>
          <select
            value={otherId}
            onChange={(e) => setOtherId(e.target.value)}
            className="min-w-0 max-w-full rounded-md border border-border bg-card px-2 py-1 text-xs"
            aria-label="Run to compare with"
          >
            <option value="">Pick a run…</option>
            {others.map((r) => (
              <option key={r.id} value={r.id}>
                {r.tickers.join(", ")} · {r.testStart.slice(0, 10)} → {r.testEnd.slice(0, 10)} · {r.id.slice(-6)}
              </option>
            ))}
          </select>
        </div>
        {otherId && (
          <div className="mt-2">
            <CompareBlock runId={runId} otherId={otherId} />
          </div>
        )}
      </div>
    </section>
  );
}
