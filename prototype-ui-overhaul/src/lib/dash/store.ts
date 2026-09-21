"use client";

import { create } from "zustand";
import type { ViewId, User, AuditEntry } from "./types";

interface DashState {
  // auth
  currentUser: User | null;
  login: (user: User) => void;
  logout: () => void;

  // navigation
  activeView: ViewId;
  setView: (v: ViewId) => void;
  backtestDetailId: string | null;
  llmDetailId: string | null;
  openBacktest: (id: string | null) => void;
  openLlm: (id: string | null) => void;

  // global ticker search
  tickerFilter: string | null;
  setTickerFilter: (t: string | null) => void;

  // env (live / backtest-N)
  env: string; // "live" or "backtest-<id>"
  setEnv: (e: string) => void;

  // auto-refresh
  autoRefresh: boolean;
  refreshIntervalMs: number;
  setAutoRefresh: (b: boolean) => void;
  setRefreshInterval: (ms: number) => void;
  lastRefreshedAt: number;
  markRefreshed: () => void;

  // audit log (for multi-user auth feature)
  audit: AuditEntry[];
  appendAudit: (entry: Omit<AuditEntry, "id" | "at" | "userId" | "username">) => void;

  // mobile more sheet
  moreSheetOpen: boolean;
  setMoreSheetOpen: (b: boolean) => void;

  // search command palette
  searchOpen: boolean;
  setSearchOpen: (b: boolean) => void;
}

export const useDash = create<DashState>((set, get) => ({
  currentUser: null,
  login: (user) => set({ currentUser: user }),
  logout: () => set({ currentUser: null, activeView: "overview" }),

  activeView: "overview",
  setView: (v) => set({ activeView: v, backtestDetailId: null, llmDetailId: null }),
  backtestDetailId: null,
  llmDetailId: null,
  openBacktest: (id) => set({ backtestDetailId: id }),
  openLlm: (id) => set({ llmDetailId: id }),

  tickerFilter: null,
  setTickerFilter: (t) => set({ tickerFilter: t }),

  env: "live",
  setEnv: (e) => set({ env: e }),

  autoRefresh: true,
  refreshIntervalMs: 15000,
  setAutoRefresh: (b) => set({ autoRefresh: b }),
  setRefreshInterval: (ms) => set({ refreshIntervalMs: ms }),
  lastRefreshedAt: Date.now(),
  markRefreshed: () => set({ lastRefreshedAt: Date.now() }),

  audit: [],
  appendAudit: (entry) => {
    const u = get().currentUser;
    if (!u) return;
    set((s) => ({
      audit: [
        {
          id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          at: new Date().toISOString(),
          userId: u.id,
          username: u.username,
          ...entry,
        },
        ...s.audit,
      ].slice(0, 200),
    }));
  },

  moreSheetOpen: false,
  setMoreSheetOpen: (b) => set({ moreSheetOpen: b }),

  searchOpen: false,
  setSearchOpen: (b) => set({ searchOpen: b }),
}));
