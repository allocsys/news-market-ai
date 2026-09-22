"use client";

import { cn } from "@/lib/utils";

interface Bar {
  approved: number;
  rejected: number;
  date: string;
}

interface BarChartProps {
  data: Bar[];
  className?: string;
  height?: number;
}

export function StackedBarChart({ data, className, height = 200 }: BarChartProps) {
  const max = Math.max(...data.map((d) => d.approved + d.rejected), 1);
  const barW = 100 / data.length;
  const stride = data.length > 14 ? Math.ceil(data.length / 7) : 1;

  return (
    <div className={cn("w-full", className)}>
      <svg width="100%" height={height} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label={`Decisions per day: ${data.length} days`}>
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <line key={p} x1={0} y1={height * (1 - p)} x2={100} y2={height * (1 - p)} stroke="var(--border)" strokeWidth={0.15} />
        ))}
        {data.map((d, i) => {
          const total = d.approved + d.rejected;
          const totalH = (total / max) * (height - 20);
          const appH = (d.approved / total) * totalH;
          const rejH = totalH - appH;
          const x = i * barW + barW * 0.18;
          const w = barW * 0.64;
          const yTop = height - 10 - totalH;
          return (
            <g key={d.date}>
              <rect x={x} y={yTop} width={w} height={Math.max(appH, 0.5)} fill="var(--chart-2)" rx={0.4}>
                <title>{`${d.date} approved: ${d.approved}`}</title>
              </rect>
              <rect x={x} y={yTop + appH} width={w} height={Math.max(rejH, 0.5)} fill="var(--chart-4)" rx={0.4}>
                <title>{`${d.date} rejected: ${d.rejected}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between mt-2 text-[10px] text-muted-foreground tabular">
        {data.map((d, i) => (i % stride === 0 ? <span key={d.date}>{d.date.slice(5)}</span> : <span key={d.date} />))}
      </div>
    </div>
  );
}
