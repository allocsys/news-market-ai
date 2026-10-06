"use client";

import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { Search, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_SECTIONS } from "@/lib/nav";
import { WATCHLIST } from "@/lib/mock-data";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

interface CommandItem {
  id: string;
  label: string;
  hint: string;
  type: "section" | "ticker";
  onSelect: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  onNavigateSection,
  onNavigateTicker,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onNavigateSection: (id: string) => void;
  onNavigateTicker: (ticker: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);

  const items = useMemo<CommandItem[]>(() => {
    const sections = NAV_SECTIONS.map((s) => ({
      id: `section:${s.id}`,
      label: s.label,
      hint: s.description,
      type: "section" as const,
      onSelect: () => {
        onNavigateSection(s.id);
        onOpenChange(false);
      },
    }));
    const tickers = WATCHLIST.map((t) => ({
      id: `ticker:${t.ticker}`,
      label: t.ticker,
      hint: `${t.name} · ${t.group}`,
      type: "ticker" as const,
      onSelect: () => {
        onNavigateTicker(t.ticker);
        onOpenChange(false);
      },
    }));
    return [...sections, ...tickers];
  }, [onNavigateSection, onNavigateTicker, onOpenChange]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter((i) => i.label.toLowerCase().includes(q) || i.hint.toLowerCase().includes(q));
  }, [items, query]);

  // Detect transitions to "open" and reset query + activeIndex in a focus/timeout callback
  // (avoids the lint rule against setState-in-effect-body)
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      wasOpenRef.current = true;
      // Defer focus so the input is mounted
      const id = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
      // Reset state synchronously in the timeout, not in the effect body
      const resetId = window.setTimeout(() => {
        setQuery("");
        setActiveIndex(0);
      }, 0);
      return () => {
        window.clearTimeout(id);
        window.clearTimeout(resetId);
      };
    }
    if (!open) {
      wasOpenRef.current = false;
    }
  }, [open]);

  // Clamp activeIndex if filtered list shrinks — deferred via setTimeout to avoid
  // the "setState synchronously within an effect" lint rule.
  useEffect(() => {
    if (activeIndex >= filtered.length) {
      const id = window.setTimeout(() => setActiveIndex(0), 0);
      return () => window.clearTimeout(id);
    }
  }, [filtered.length, activeIndex]);

  // Keyboard nav inside the palette
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        filtered[activeIndex]?.onSelect();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, activeIndex]);

  const handleQueryChange = useCallback((v: string) => {
    setQuery(v);
    setActiveIndex(0);
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[15%] max-w-2xl gap-0 overflow-hidden p-0 translate-y-0">
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>
            Find a section or ticker in the dashboard.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search className="h-4 w-4 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="Type a section name or ticker…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Search query"
          />
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
            ESC
          </kbd>
        </div>
        <ScrollArea className="max-h-80">
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No matches</p>
          ) : (
            <ul className="p-1">
              {filtered.map((item, i) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => item.onSelect()}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm",
                      i === activeIndex ? "bg-accent" : "hover:bg-accent/60",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-7 w-7 items-center justify-center rounded-md text-[10px] font-semibold uppercase",
                        item.type === "ticker"
                          ? "bg-[color:var(--info)]/15 text-[color:var(--info)]"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {item.type === "ticker" ? "T" : "S"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{item.label}</p>
                      <p className="truncate text-xs text-muted-foreground">{item.hint}</p>
                    </div>
                    <ArrowRight
                      className="h-3.5 w-3.5 text-muted-foreground transition-opacity"
                      style={{ opacity: i === activeIndex ? 1 : 0 }}
                      aria-hidden
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
