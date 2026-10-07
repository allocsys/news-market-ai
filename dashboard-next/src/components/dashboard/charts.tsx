"use client";

import { cn } from "@/lib/utils";
import { useMemo } from "react";

// ============================================================
// Sparkline — pure SVG line+area, color by direction
// ============================================================
export function Sparkline({
  values,
  width = 120,
  height = 36,
  stroke,
  fill,
  className,
  showArea = true,
}: {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  className?: string;
  showArea?: boolean;
}) {
  if (!values || values.length < 2) {
    return <div className={cn("text-xs text-muted-foreground", className)}>—</div>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 2;
  const stepX = (width - pad * 2) / (values.length - 1);
  const points = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (height - pad * 2) * (1 - (v - min) / range);
    return [x, y] as const;
  });
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L${points[points.length - 1][0].toFixed(2)},${height - pad} L${points[0][0].toFixed(2)},${height - pad} Z`;
  const up = values[values.length - 1] >= values[0];
  const s = stroke ?? (up ? "var(--long)" : "var(--short)");
  const f = fill ?? (up ? "color-mix(in oklch, var(--long) 18%, transparent)" : "color-mix(in oklch, var(--short) 18%, transparent)");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("overflow-visible", className)}
      aria-hidden
    >
      {showArea && <path d={areaPath} fill={f} stroke="none" />}
      <path d={linePath} fill="none" stroke={s} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={points[points.length - 1][0]} cy={points[points.length - 1][1]} r={2} fill={s} />
    </svg>
  );
}

// ============================================================
// Stacked bar (horizontal) — for composition rows
// ============================================================
export function StackedBar({
  segments,
  className,
  height = 8,
}: {
  segments: { value: number; color: string; label?: string }[];
  className?: string;
  height?: number;
}) {
  const total = segments.reduce((s, seg) => s + seg.value, 0) || 1;
  return (
    <div
      className={cn("flex w-full overflow-hidden rounded-full", className)}
      style={{ height }}
      role="img"
      aria-label={`Stacked bar: ${segments.map((s) => `${s.label ?? ""} ${((s.value / total) * 100).toFixed(0)}%`).join(", ")}`}
    >
      {segments.map((seg, i) => (
        <div
          key={i}
          style={{
            width: `${(seg.value / total) * 100}%`,
            backgroundColor: seg.color,
          }}
          title={seg.label}
        />
      ))}
    </div>
  );
}

// ============================================================
// Donut chart — with side legend
// ============================================================
export function DonutChart({
  segments,
  centerValue,
  centerLabel,
  size = 120,
  thickness = 14,
  className,
}: {
  segments: { value: number; color: string; label: string }[];
  centerValue?: React.ReactNode;
  centerLabel?: React.ReactNode;
  size?: number;
  thickness?: number;
  className?: string;
}) {
  const total = segments.reduce((s, seg) => s + seg.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  // Pre-compute each segment's dasharray and the cumulative dashoffset using a
  // pure reduce (no outer-variable reassignment, which trips the immutability lint rule).
  const segmentData = useMemo(() => {
    return segments.reduce<
      { dasharray: string; dashoffset: number; color: string }[]
    >((acc, seg) => {
      const len = (seg.value / total) * c;
      const prevLen = acc.length === 0 ? 0 : parseFloat(acc[acc.length - 1].dasharray);
      const dashoffset = acc.length === 0 ? 0 : acc[acc.length - 1].dashoffset - prevLen;
      return [
        ...acc,
        { dasharray: `${len} ${c - len}`, dashoffset, color: seg.color },
      ];
    }, []);
  }, [segments, total, c]);

  return (
    <div className={cn("flex items-center gap-4", className)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <g transform={`translate(${size / 2}, ${size / 2}) rotate(-90)`}>
          <circle r={r} fill="none" stroke="var(--muted)" strokeWidth={thickness} opacity={0.4} />
          {segmentData.map((data, i) => (
            <circle
              key={i}
              r={r}
              fill="none"
              stroke={data.color}
              strokeWidth={thickness}
              strokeDasharray={data.dasharray}
              strokeDashoffset={data.dashoffset}
              strokeLinecap="butt"
            />
          ))}
        </g>
        {centerValue != null && (
          <text x="50%" y="48%" textAnchor="middle" dominantBaseline="middle" className="fill-foreground font-mono text-base font-semibold nums">
            {centerValue}
          </text>
        )}
        {centerLabel && (
          <text x="50%" y="62%" textAnchor="middle" dominantBaseline="middle" className="fill-muted-foreground text-[9px]">
            {centerLabel}
          </text>
        )}
      </svg>
      <ul className="space-y-1 text-xs">
        {segments.map((seg, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: seg.color }} aria-hidden />
            <span className="text-muted-foreground">{seg.label}</span>
            <span className="ml-auto font-mono nums">
              {((seg.value / total) * 100).toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ============================================================
// Gauge — semicircular, with min/max labels
// ============================================================
export function Gauge({
  value,
  min = 0,
  max = 100,
  label,
  valueLabel,
  accent = "var(--primary)",
  size = 140,
  className,
}: {
  value: number;
  min?: number;
  max?: number;
  label?: string;
  valueLabel?: React.ReactNode;
  accent?: string;
  size?: number;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const thickness = 12;
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  // Both arcs run left -> right THROUGH THE TOP (sweep-flag 1 is clockwise on screen). The SVG is only
  // size/2 + 12 tall, so the arc has to live in the upper half: an earlier version drew it under a
  // rotate(180), which put it below the viewBox and left just the two end caps visible.
  const track = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  const ex = cx - r * Math.cos(pct * Math.PI);
  const ey = cy - r * Math.sin(pct * Math.PI);
  // pct <= 1 means the value arc never exceeds 180 degrees, so large-arc is always 0. Nothing to draw at 0
  // (a round cap would paint a dot that reads as a value).
  const valueArc = pct > 0 ? `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${ex} ${ey}` : null;

  return (
    <div className={cn("flex flex-col items-center", className)}>
      <svg width={size} height={size / 2 + 12} viewBox={`0 0 ${size} ${size / 2 + 12}`}>
        {/* Track */}
        <path d={track} fill="none" stroke="var(--muted)" strokeWidth={thickness} strokeLinecap="round" opacity={0.4} />
        {/* Value */}
        {valueArc && <path d={valueArc} fill="none" stroke={accent} strokeWidth={thickness} strokeLinecap="round" />}
        {valueLabel && (
          <text x="50%" y="62%" textAnchor="middle" dominantBaseline="middle" className="fill-foreground font-mono text-xl font-semibold nums">
            {valueLabel}
          </text>
        )}
      </svg>
      {label && <p className="mt-1 text-[11px] text-muted-foreground">{label}</p>}
    </div>
  );
}

// ============================================================
// Vertical stacked bar chart — for daily activity
// ============================================================
export function DailyStackedBar({
  data,
  colorMap,
  height = 140,
  className,
}: {
  data: { day: string; status: string; count: number }[];
  colorMap: Record<string, string>;
  height?: number;
  className?: string;
}) {
  // Group by day
  const byDay = new Map<string, { status: string; count: number }[]>();
  for (const row of data) {
    if (!byDay.has(row.day)) byDay.set(row.day, []);
    byDay.get(row.day)!.push({ status: row.status, count: row.count });
  }
  const days = Array.from(byDay.keys()).sort();
  const maxCount = Math.max(
    1,
    ...days.map((d) => byDay.get(d)!.reduce((s, r) => s + r.count, 0)),
  );

  return (
    <div className={cn("w-full", className)}>
      <div className="flex items-end gap-[2px] overflow-x-auto no-scrollbar" style={{ height }}>
        {days.map((day) => {
          const rows = byDay.get(day)!;
          const total = rows.reduce((s, r) => s + r.count, 0);
          return (
            <div
              key={day}
              className="group relative flex h-full flex-1 min-w-[6px] flex-col justify-end"
              title={`${day}: ${total} decisions`}
            >
              {rows
                .slice()
                .sort((a, b) => {
                  // opened at bottom, then rejected on top, then others
                  const order = (s: string) => (s === "opened" ? 0 : s === "rejected" ? 2 : 1);
                  return order(a.status) - order(b.status);
                })
                .map((r, i) => (
                  <div
                    key={i}
                    style={{
                      height: `${(r.count / maxCount) * 100}%`,
                      backgroundColor: colorMap[r.status] ?? "var(--muted-foreground)",
                    }}
                    className="w-full"
                  />
                ))}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{days[0]}</span>
        <span>{days[Math.floor(days.length / 2)]}</span>
        <span>{days[days.length - 1]}</span>
      </div>
    </div>
  );
}

// ============================================================
// Equity curve — line chart with optional markers
// ============================================================
export function EquityCurve({
  dates,
  onValues,
  offValues,
  positions = [],
  height = 220,
  className,
}: {
  dates: string[];
  onValues: number[];
  offValues?: number[];
  positions?: { date?: string; direction: "long" | "short" | "neutral"; profit?: boolean }[];
  height?: number;
  className?: string;
}) {
  if (dates.length < 2) return null;
  const width = 600;
  const pad = { l: 8, r: 8, t: 12, b: 18 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;

  const allValues = [...onValues, ...(offValues ?? [])];
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const range = max - min || 1;

  const toXY = (vals: number[]) =>
    vals.map((v, i) => {
      const x = pad.l + (i / (vals.length - 1)) * innerW;
      const y = pad.t + innerH * (1 - (v - min) / range);
      return [x, y] as const;
    });

  const onPoints = toXY(onValues);
  const offPoints = offValues ? toXY(offValues) : [];
  const onPath = onPoints.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const offPath = offPoints.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const onArea = `${onPath} L${onPoints[onPoints.length - 1][0].toFixed(1)},${pad.t + innerH} L${onPoints[0][0].toFixed(1)},${pad.t + innerH} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      className={className}
      role="img"
      aria-label="Equity curve"
    >
      <defs>
        <linearGradient id="onGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.25} />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
        </linearGradient>
      </defs>
      {/* Baseline */}
      <line
        x1={pad.l}
        x2={width - pad.r}
        y1={pad.t + innerH}
        y2={pad.t + innerH}
        stroke="var(--border)"
        strokeWidth={1}
      />
      {/* Off (buy & hold) — dashed */}
      {offPath && (
        <path d={offPath} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.25} strokeDasharray="4 3" opacity={0.6} />
      )}
      {/* On (strategy) — area + line */}
      <path d={onArea} fill="url(#onGrad)" />
      <path d={onPath} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {/* Position markers */}
      {positions.map((p, i) => {
        if (!p.date) return null;
        const idx = dates.indexOf(p.date);
        if (idx < 0) return null;
        const x = pad.l + (idx / (dates.length - 1)) * innerW;
        const y = pad.t + innerH * 0.5;
        const color = p.profit === false ? "var(--short)" : p.profit === true ? "var(--long)" : "var(--muted-foreground)";
        const tri = p.direction === "short" ? `${x},${y - 5} ${x - 4},${y + 3} ${x + 4},${y + 3}` : `${x},${y + 5} ${x - 4},${y - 3} ${x + 4},${y - 3}`;
        return <polygon key={i} points={tri} fill={color} opacity={0.9} />;
      })}
    </svg>
  );
}
