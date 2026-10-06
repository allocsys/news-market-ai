// Navigation configuration — single source of truth for the sidebar,
// bottom nav, mobile "More" sheet, and the section sub-tab strips.

import {
  LayoutDashboard,
  Wallet,
  TrendingUp,
  ScrollText,
  GitBranch,
  Cpu,
  Download,
  FlaskConical,
  Activity,
  BarChart3,
  HeartPulse,
  Settings,
  MoreHorizontal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavSection {
  id: string;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
  description: string;
  group: "today" | "book" | "signals" | "system";
  envAware?: boolean;
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id: "overview",
    label: "Today",
    shortLabel: "Today",
    icon: LayoutDashboard,
    description: "Command center: open positions, exposure, latest decision, pipeline pulse",
    group: "today",
    envAware: true,
  },
  {
    id: "positions",
    label: "Positions",
    shortLabel: "Book",
    icon: Wallet,
    description: "Open exposure, open & recently closed positions, charts",
    group: "book",
    envAware: true,
  },
  {
    id: "snapshot",
    label: "Recent exits",
    shortLabel: "Exits",
    icon: TrendingUp,
    description: "Last 20 closed positions, newest first",
    group: "book",
    envAware: true,
  },
  {
    id: "charts",
    label: "Charts",
    shortLabel: "Charts",
    icon: BarChart3,
    description: "30-day price sparklines for open-position tickers",
    group: "book",
  },
  {
    id: "decisions",
    label: "Decisions",
    shortLabel: "Decisions",
    icon: ScrollText,
    description: "Recent trade decisions with LLM reasoning",
    group: "signals",
    envAware: true,
  },
  {
    id: "pipeline",
    label: "Pipeline",
    shortLabel: "Pipeline",
    icon: GitBranch,
    description: "Recent pipeline checkpoints by stage",
    group: "signals",
    envAware: true,
  },
  {
    id: "activity",
    label: "Activity",
    shortLabel: "Activity",
    icon: Activity,
    description: "Decisions per UTC day, stacked by status",
    group: "signals",
    envAware: true,
  },
  {
    id: "llm",
    label: "LLM Calls",
    shortLabel: "LLM",
    icon: Cpu,
    description: "Every Gemini prompt & response, newest first",
    group: "signals",
    envAware: true,
  },
  {
    id: "backtest",
    label: "Backtest",
    shortLabel: "Backtest",
    icon: FlaskConical,
    description: "Start, list, and maintain backtests",
    group: "system",
  },
  {
    id: "backfill",
    label: "Backfill",
    shortLabel: "Backfill",
    icon: Download,
    description: "Trigger historical news & price backfills",
    group: "system",
  },
  {
    id: "health",
    label: "Health",
    shortLabel: "Health",
    icon: HeartPulse,
    description: "Ingestion row counts & last ingested time",
    group: "system",
  },
  {
    id: "controls",
    label: "Controls",
    shortLabel: "Controls",
    icon: Settings,
    description: "Pause switches & live ticker selection",
    group: "system",
  },
];

export const NAV_GROUPS: { id: NavSection["group"]; label: string; mobileTab: boolean; sections: string[] }[] = [
  { id: "today", label: "Today", mobileTab: true, sections: ["overview"] },
  { id: "book", label: "Book", mobileTab: true, sections: ["positions", "snapshot", "charts"] },
  { id: "signals", label: "Signals", mobileTab: true, sections: ["decisions", "pipeline", "activity", "llm"] },
  { id: "system", label: "System", mobileTab: false, sections: ["backtest", "backfill", "health", "controls"] },
];

// Mobile bottom-nav tabs (4 + More)
export const MOBILE_TABS: { id: string; label: string; icon: LucideIcon; sectionId: string }[] = [
  { id: "today", label: "Today", icon: LayoutDashboard, sectionId: "overview" },
  { id: "book", label: "Book", icon: Wallet, sectionId: "positions" },
  { id: "signals", label: "Signals", icon: ScrollText, sectionId: "decisions" },
  { id: "more", label: "More", icon: MoreHorizontal, sectionId: "more" },
];

export function getSection(id: string): NavSection | undefined {
  return NAV_SECTIONS.find((s) => s.id === id);
}

export function getGroupForSection(sectionId: string): NavSection["group"] | undefined {
  return NAV_SECTIONS.find((s) => s.id === sectionId)?.group;
}

export function getSiblingSections(sectionId: string): NavSection[] {
  const group = getGroupForSection(sectionId);
  if (!group) return [];
  return NAV_SECTIONS.filter((s) => s.group === group);
}
