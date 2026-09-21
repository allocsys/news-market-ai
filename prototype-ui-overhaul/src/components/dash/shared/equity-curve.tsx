"use client";

import { cn } from "@/lib/utils";
import type { EquityPoint } from "@/lib/dash/types";

interface EquityCurveProps {
  data: EquityPoint[];
  height?: number;
  className?: string;
  showBuyHold?: boolean;
}

export function EquityCurve({ data, height = 260, className, showBuyHold = true }: EquityCurveProps) {
  if (!data || data.length === 0) {
    return (
      <div className={cn("flex items-center justify-center text-muted-foreground text-sm", className)} style={{ height }}>
        No equity data
      </div>
    );
  }
  const all = data.flatMap((d) => [d.signal, showBuyHold ? d.buyHold : d.signal]);
  const min = Math.min(0, ...all);
  const max = Math.max(0, ...all);
  const range = max - min || 1;
  const width = 100;
  const stepX = width / (data.length - 1);

  const y = (v: number) => height - 24 - ((v - min) / range) * (height - 48);

  const sigPath = data.map((d, i) => `${i === 0 ? "M" : "L"} ${i * stepX} ${y(d.signal)}`).join(" ");
  const bhPath = showBuyHold
    ? data.map((d, i) => `${i === 0 ? "M" : "L"} ${i * stepX} ${y(d.buyHold)}`).join(" ")
    : "";
  const zeroY = y(0);
  const sigGradId = `eq-sig-${Math.random().toString(36).slice(2, 8)}`;

  return (
    <div className={cn("w-full", className)}>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Equity curve, signal-on return ${data[data.length - 1].signal.toFixed(2)}% vs buy & hold ${data[data.length - 1].buyHold.toFixed(2)}%`}>
        <defs>
          <linearGradient id={sigGradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.25} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((p) => {
          const val = min + p * range;
          return (
            <g key={p}>
              <line x1={0} y1={y(val)} x2={width} y2={y(val)} stroke="var(--border)" strokeWidth={0.15} />
              <text x={2} y={y(val) - 1} fontSize={2.2} fill="var(--muted-foreground)" className="tabular">
                {val.toFixed(0)}%
              </text>
            </g>
          );
        })}
        <line x1={0} y1={zeroY} x2={width} y2={zeroY} stroke="var(--border)" strokeWidth={0.25} />
        {showBuyHold && (
          <path d={bhPath} fill="none" stroke="var(--muted-foreground)" strokeWidth={0.6} strokeDasharray="2 2" />
        )}
        <path d={`${sigPath} L ${width} ${height} L 0 ${height} Z`} fill={`url(#${sigGradId})`} />
        <path d={sigPath} fill="none" stroke="var(--chart-1)" strokeWidth={0.9} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={(data.length - 1) * stepX} cy={y(data[data.length - 1].signal)} r={1.2} fill="var(--chart-1)" />
      </svg>
      <div className="flex items-center justify-between mt-2 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-[var(--chart-1)] rounded-full" /> Signal ON
          </span>
          {showBuyHold && (
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 border-t-2 border-dashed border-[var(--muted-foreground)]" /> Buy & hold
            </span>
          )}
        </div>
        <div className="flex justify-between flex-1 ml-4">
          <span>{data[0].date.slice(5)}</span>
          <span>{data[data.length - 1].date.slice(5)}</span>
        </div>
      </div>
    </div>
  );
}
