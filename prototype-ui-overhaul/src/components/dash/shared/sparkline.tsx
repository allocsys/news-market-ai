"use client";

import { cn } from "@/lib/utils";

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  showArea?: boolean;
  className?: string;
}

export function Sparkline({
  data,
  width = 240,
  height = 64,
  color,
  fill = true,
  className,
}: SparklineProps) {
  if (!data || data.length === 0) {
    return (
      <svg width={width} height={height} className={className} role="img" aria-label="No data">
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="var(--border)" strokeDasharray="3 4" />
      </svg>
    );
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);

  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = height - 4 - ((v - min) / range) * (height - 8);
    return { x, y };
  });

  const linePath = points
    .map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`))
    .join(" ");

  const areaPath = `${linePath} L ${width} ${height} L 0 ${height} Z`;

  const trend = data[data.length - 1] >= data[0] ? "up" : "down";
  const stroke = color ?? (trend === "up" ? "var(--chart-2)" : "var(--chart-4)");
  const gradId = `spark-${Math.random().toString(36).slice(2, 9)}`;

  return (
    <svg width={width} height={height} className={className} role="img" aria-label={`Sparkline: ${data[0].toFixed(2)} → ${data[data.length - 1].toFixed(2)}`}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.25} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      {fill && <path d={areaPath} fill={`url(#${gradId})`} />}
      <path d={linePath} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r={2.5} fill={stroke} />
    </svg>
  );
}
