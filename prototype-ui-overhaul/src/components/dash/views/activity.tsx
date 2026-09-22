"use client";

import { useState } from "react";
import {
  ACTIVITY_7D, ACTIVITY_14D, ACTIVITY_30D, ACTIVITY_60D,
} from "@/lib/dash/mock-data";
import { Panel, PageHeader, FilterPills } from "../shared/primitives";
import { StackedBarChart } from "../shared/bar-chart";
import { MiniStats } from "../shared/stat-card";
import type { ActivityDay } from "@/lib/dash/types";

const RANGE_PILLS = [
  { value: "7", label: "7d" },
  { value: "14", label: "14d" },
  { value: "30", label: "30d" },
  { value: "60", label: "60d" },
];

const RANGES: Record<string, ActivityDay[]> = {
  "7": ACTIVITY_7D,
  "14": ACTIVITY_14D,
  "30": ACTIVITY_30D,
  "60": ACTIVITY_60D,
};

export function ActivityView() {
  const [range, setRange] = useState("14");
  const data = RANGES[range];

  const totalApproved = data.reduce((s, d) => s + d.approved, 0);
  const totalRejected = data.reduce((s, d) => s + d.rejected, 0);
  const total = totalApproved + totalRejected;
  const approvalRate = total ? (totalApproved / total) * 100 : 0;
  const peak = Math.max(...data.map((d) => d.approved + d.rejected));
  const peakDay = data.find((d) => d.approved + d.rejected === peak)?.date;
  const avgPerDay = (total / data.length).toFixed(1);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity"
        description="Pipeline decisions per UTC day, split by approval status. Use the range pills to zoom in/out. A zero-height day means the pipeline produced no decisions that day — it doesn't distinguish 'quiet market' from 'run failed before reaching this stage'."
        actions={<FilterPills pills={RANGE_PILLS} value={range} onChange={setRange} ariaLabel="Date range" />}
      />

      <Panel
        title="Decisions per day"
        subtitle={`${data.length} days · ${total} total decisions`}
        actions={
          <div className="flex items-center gap-3 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-[var(--chart-2)]" /> Approved
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-[var(--chart-4)]" /> Rejected
            </span>
          </div>
        }
      >
        <StackedBarChart data={data} height={240} />
      </Panel>

      <Panel title="Window totals" subtitle={`Across the selected ${data.length}-day window`}>
        <MiniStats
          cols={2}
          items={[
            { label: "Total decisions", value: String(total), sub: `${data.length} days` },
            { label: "Approved", value: String(totalApproved), accent: "emerald", sub: `${approvalRate.toFixed(1)}% of total` },
            { label: "Rejected", value: String(totalRejected), accent: "red", sub: `${(100 - approvalRate).toFixed(1)}% of total` },
            { label: "Peak day", value: String(peak), sub: peakDay ? peakDay.slice(5) : "—" },
            { label: "Avg / day", value: avgPerDay, sub: "decisions per day" },
            { label: "Days with activity", value: String(data.filter((d) => d.approved + d.rejected > 0).length), sub: `of ${data.length}` },
          ]}
        />
      </Panel>
    </div>
  );
}
