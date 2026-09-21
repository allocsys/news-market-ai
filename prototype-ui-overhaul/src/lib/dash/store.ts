"use client";

import { create } from "zustand";
import type { ViewId } from "./types";

interface DashState {
  // auth
  currentUser: string | null;
  login: (username: string) => void;
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

  // mobile more sheet
  moreSheetOpen: boolean;
  setMoreSheetOpen: (b: boolean) => void;

  // search command palette
  searchOpen: boolean;
  setSearchOpen: (b: boolean) => void;
}

export const useDash = create<DashState>((set) => ({
  currentUser: null,
  login: (username) => set({ currentUser: username }),
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

  moreSheetOpen: false,
  setMoreSheetOpen: (b) => set({ moreSheetOpen: b }),

  searchOpen: false,
  setSearchOpen: (b) => set({ searchOpen: b }),
}));
