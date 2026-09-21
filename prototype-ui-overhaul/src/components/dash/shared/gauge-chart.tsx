"use client";

import { cn } from "@/lib/utils";

interface GaugeChartProps {
  value: number; // 0..1
  valueLabel?: string;
  label?: string;
  size?: number;
  thickness?: number;
  accent?: string; // hex/var
  thresholds?: { upTo: number; color: string }[]; // [{upTo:0.5,color:'var(--success)'},{upTo:0.8,...},{...}]
  className?: string;
}

export function GaugeChart({
  value,
  valueLabel,
  label,
  size = 160,
  thickness = 14,
  accent,
  thresholds = [
    { upTo: 0.5, color: "var(--chart-2)" },
    { upTo: 0.8, color: "var(--chart-3)" },
    { upTo: 1.01, color: "var(--chart-4)" },
  ],
  className,
}: GaugeChartProps) {
  const v = Math.max(0, Math.min(1, value));
  const radius = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  // Semi-circle: half circumference
  const halfCirc = Math.PI * radius;
  // The arc spans 180° (from -90° (left) to +90° (right) via top)
  // We'll draw from left (180°) to right (0°), going clockwise over the top.
  // Using a path for the track + filled portion is cleaner than stroke-dasharray on a circle.

  const trackPath = describeArc(cx, cy, radius, 180, 0);
  const valueAngle = 180 - 180 * v; // 180 (empty) → 0 (full)
  const valuePath = describeArc(cx, cy, radius, 180, valueAngle);

  const activeColor =
    accent ??
    (thresholds.find((t) => v <= t.upTo)?.color ?? "var(--chart-1)");

  // Tick marks every 20%
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1.0].map((p) => {
    const angle = 180 - 180 * p;
    const rad = (angle * Math.PI) / 180;
    const x1 = cx + (radius - thickness / 2 - 2) * Math.cos(rad);
    const y1 = cy - (radius - thickness / 2 - 2) * Math.sin(rad);
    const x2 = cx + (radius + thickness / 2 + 2) * Math.cos(rad);
    const y2 = cy - (radius + thickness / 2 + 2) * Math.sin(rad);
    return { x1, y1, x2, y2, p };
  });

  return (
    <div className={cn("flex flex-col items-center", className)}>
      <svg width={size} height={size / 2 + 18} viewBox={`0 0 ${size} ${size / 2 + 18}`} role="img" aria-label={`${label ?? "gauge"}: ${valueLabel ?? `${(v * 100).toFixed(1)}%`}`}>
        <path d={trackPath} fill="none" stroke="var(--muted)" strokeWidth={thickness} strokeLinecap="round" opacity={0.35} />
        <path d={valuePath} fill="none" stroke={activeColor} strokeWidth={thickness} strokeLinecap="round" />
        {ticks.map((t) => (
          <line
            key={t.p}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            stroke="var(--muted-foreground)"
            strokeWidth={1}
            opacity={0.45}
          />
        ))}
        {valueLabel && (
          <text x={cx} y={cy - size * 0.04} textAnchor="middle" className="fill-foreground tabular" style={{ fontSize: size * 0.16, fontWeight: 700 }}>
            {valueLabel}
          </text>
        )}
        {label && (
          <text x={cx} y={cy + size * 0.08} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: size * 0.07, letterSpacing: "0.10em", textTransform: "uppercase" }}>
            {label}
          </text>
        )}
      </svg>
    </div>
  );
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = startAngle - endAngle <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}
