"use client";

import { cn } from "@/lib/utils";

interface FilterPill {
  value: string;
  label: string;
}

interface FilterPillsProps {
  pills: FilterPill[];
  value: string;
  onChange: (v: string) => void;
  className?: string;
  ariaLabel?: string;
}

export function FilterPills({ pills, value, onChange, className, ariaLabel }: FilterPillsProps) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      role="group"
      aria-label={ariaLabel}
    >
      {pills.map((p) => (
        <button
          key={p.value}
          onClick={() => onChange(p.value)}
          aria-pressed={value === p.value}
          className={cn(
            "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
            "min-h-[28px] min-w-[28px] inline-flex items-center justify-center",
            value === p.value
              ? "border-primary/50 bg-primary/15 text-primary"
              : "border-border bg-card text-muted-foreground hover:text-foreground hover:border-foreground/20"
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

interface PanelProps {
  title?: string;
  subtitle?: string;
  count?: number;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  flush?: boolean;
}

export function Panel({ title, subtitle, count, actions, children, className, bodyClassName, flush }: PanelProps) {
  return (
    <section className={cn("rounded-xl border border-border bg-card overflow-hidden", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border/60">
          <div className="min-w-0">
            {title && (
              <h3 className="text-sm font-semibold tracking-tight flex items-center gap-2">
                {title}
                {count !== undefined && (
                  <span className="tabular text-[10px] font-medium px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                    {count}
                  </span>
                )}
              </h3>
            )}
            {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="shrink-0 flex items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cn(flush ? "" : "p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  count?: number;
}

export function PageHeader({ title, description, actions, count }: PageHeaderProps) {
  return (
    <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-3 mb-5">
      <div className="min-w-0">
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight flex items-center gap-2.5">
          {title}
          {count !== undefined && (
            <span className="tabular text-xs font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">
              {count}
            </span>
          )}
        </h1>
        {description && <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">{description}</p>}
      </div>
      {actions && <div className="shrink-0 flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
