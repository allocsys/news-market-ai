"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

// A view that throws while rendering (typically a run whose stored data is shaped
// differently from what the view expects) used to take the whole dashboard down with
// "Application error". This keeps the shell and env selector alive, shows what broke,
// and offers a way out. Mount it with a `key` that changes with section/env so
// picking another run or section clears the error.
interface Props {
  children: ReactNode;
  /** Shown as the way out, e.g. "Back to live". */
  onReset?: () => void;
  resetLabel?: string;
}

interface State {
  error: Error | null;
}

export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("View crashed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const where = error.stack
      ?.split("\n")
      .slice(1, 3)
      .map((l) => l.trim())
      .join("\n");
    return (
      <div className="rounded-xl border border-[color:var(--short)]/30 bg-[color:var(--short)]/8 p-4 text-sm">
        <div className="flex items-center gap-2 font-medium text-[color:var(--short)]">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          This view couldn&apos;t be displayed
        </div>
        <p className="mt-2 break-words font-mono text-xs text-foreground/90">
          {error.name}: {error.message}
        </p>
        {where && (
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground">
            {where}
          </pre>
        )}
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent/40"
          >
            Try again
          </button>
          {this.props.onReset && (
            <button
              type="button"
              onClick={() => {
                this.setState({ error: null });
                this.props.onReset?.();
              }}
              className="text-xs font-medium text-primary hover:underline"
            >
              {this.props.resetLabel ?? "Back to live"}
            </button>
          )}
        </div>
      </div>
    );
  }
}
