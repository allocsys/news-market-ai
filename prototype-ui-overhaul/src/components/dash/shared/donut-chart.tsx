"use client";

import { cn } from "@/lib/utils";

interface DonutSegment {
  label: string;
  value: number;
  color: string; // hex or var(--chart-N)
}

interface DonutChartProps {
  segments: DonutSegment[];
  centerValue?: string;
  centerLabel?: string;
  size?: number;
  thickness?: number;
  className?: string;
}

export function DonutChart({
  segments,
  centerValue,
  centerLabel,
  size = 140,
  thickness = 14,
  className,
}: DonutChartProps) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const cx = size / 2;
  const cy = size / 2;

  if (total === 0 || segments.every((s) => s.value === 0)) {
    return (
      <div className={cn("flex items-center justify-center", className)} style={{ width: size, height: size }}>
        <svg width={size} height={size} role="img" aria-label="No data available">
          <circle cx={cx} cy={cy} r={radius} fill="none" stroke="var(--border)" strokeWidth={thickness} opacity={0.5} />
          <text x={cx} y={cy - 4} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: size * 0.18, fontWeight: 600 }}>
            --
          </text>
          <text x={cx} y={cy + size * 0.16} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: size * 0.085, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            no data
          </text>
        </svg>
      </div>
    );
  }

  // Compute cumulative offsets without mutation in the render path.
  const segmentsWithGeometry = segments.reduce<
    { seg: DonutSegment; dash: number; offset: number }[]
  >((acc, seg) => {
    const frac = seg.value / total;
    const dash = frac * circumference;
    const offset = acc.reduce((sum, x) => sum + x.dash, 0);
    acc.push({ seg, dash, offset });
    return acc;
  }, []);

  const arcs = segmentsWithGeometry.map(({ seg, dash, offset }) => (
    <circle
      key={seg.label}
      cx={cx}
      cy={cy}
      r={radius}
      fill="none"
      stroke={seg.color}
      strokeWidth={thickness}
      strokeDasharray={`${dash} ${circumference - dash}`}
      strokeDashoffset={-offset}
      strokeLinecap="butt"
      transform={`rotate(-90 ${cx} ${cy})`}
    >
      <title>{`${seg.label}: ${seg.value} (${((seg.value / total) * 100).toFixed(1)}%)`}</title>
    </circle>
  ));

  return (
    <div className={cn("flex items-center justify-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} role="img" aria-label={`Donut chart: ${segments.map((s) => `${s.label} ${s.value}`).join(", ")}`}>
        <circle cx={cx} cy={cy} r={radius} fill="none" stroke="var(--muted)" strokeWidth={thickness} opacity={0.35} />
        {arcs}
        {centerValue && (
          <text x={cx} y={cy - 2} textAnchor="middle" className="fill-foreground tabular" style={{ fontSize: size * 0.20, fontWeight: 700 }}>
            {centerValue}
          </text>
        )}
        {centerLabel && (
          <text x={cx} y={cy + size * 0.16} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: size * 0.085, letterSpacing: "0.10em", textTransform: "uppercase" }}>
            {centerLabel}
          </text>
        )}
      </svg>
    </div>
  );
}

interface DonutLegendProps {
  segments: DonutSegment[];
  className?: string;
}

export function DonutLegend({ segments, className }: DonutLegendProps) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <ul className={cn("space-y-1.5 text-sm", className)}>
      {segments.map((seg) => (
        <li key={seg.label} className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 min-w-0">
            <span className="size-2.5 rounded-full shrink-0" style={{ background: seg.color }} aria-hidden />
            <span className="truncate text-muted-foreground">{seg.label}</span>
          </span>
          <span className="tabular text-foreground shrink-0">
            {seg.value} <span className="text-muted-foreground text-xs">({((seg.value / total) * 100).toFixed(0)}%)</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
