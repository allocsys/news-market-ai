// Shared view props — every view receives the same set of helpers
// so they can navigate to each other (e.g. Overview → Decisions).

export interface ViewProps {
  onNavigate: (sectionId: string, opts?: { ticker?: string; decisionId?: string; llmCallId?: number; backtestId?: string }) => void;
  env: string;
  onEnvChange: (env: string) => void;
}

export interface LlmDetailViewProps extends ViewProps {
  llmCallId: number | null;
  onClose: () => void;
}

export interface BacktestDetailViewProps extends ViewProps {
  backtestId: string | null;
  onClose: () => void;
}

export interface DecisionsViewProps extends ViewProps {
  tickerFilter?: string;
}

export interface LlmViewProps extends ViewProps {
  tickerFilter?: string;
}
