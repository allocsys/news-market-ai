export const signalsCss = `
.sig-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.sig-chip {
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--text-muted);
}
.sig-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sig-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sig-card-top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 0.8125rem;
}
.sig-card-top .ticker {
  font-size: 1rem;
  font-weight: 600;
}
.sig-card-time {
  margin-left: auto;
  color: var(--text-subtle);
  font-size: 0.75rem;
  font-family: var(--font-mono);
}
.sig-card-mid {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}
.sig-card-size {
  font-family: var(--font-mono);
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--text-main);
  flex-shrink: 0;
}
.sig-card-reason {
  font-size: 0.8125rem;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
details.sig-activity {
  margin-top: 16px;
  margin-bottom: 16px;
}
details.sig-activity summary {
  display: flex;
  align-items: center;
  min-height: 44px;
  padding: 0 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  cursor: pointer;
  font-family: var(--font-display);
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--text-main);
  list-style: none;
  user-select: none;
}
details.sig-activity summary::-webkit-details-marker {
  display: none;
}
details.sig-activity summary::before {
  content: "\\25b8 ";
  margin-right: 8px;
  opacity: 0.7;
}
details.sig-activity[open] summary::before {
  content: "\\25be ";
}
details.sig-activity .panel-body {
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-top: none;
  border-radius: 0 0 var(--radius-md) var(--radius-md);
  padding: 16px;
}
.sig-link-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 12px 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  text-decoration: none;
  color: var(--text-main);
}
.sig-link-row:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}
.sig-link-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sig-link-title {
  font-family: var(--font-display);
  font-size: 0.9375rem;
  font-weight: 600;
}
.sig-link-desc {
  font-size: 0.8125rem;
  color: var(--text-muted);
}
.sig-link-chevron {
  color: var(--text-subtle);
  font-size: 1.5rem;
  line-height: 1;
}
.summary-count { display: none; }
/* Phone only: the tab already says Decisions, so drop the H2 + intro and keep
   the count in the summary header; compact the summary to one tight block. */
@media (max-width: 767px) {
  #decisions > h2,
  #decisions > .note { display: none; }
  .summary-count {
    display: inline-block; margin-left: 0.4rem;
    font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-muted);
  }
  .decisions-summary .panel-header { padding: 0.5rem 0.75rem; }
  .decisions-summary .panel-body { padding: 0.6rem 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .decisions-summary .stack + .stack .stack-legend,
  .decisions-summary .stack + .stack .stack-title { display: none; }
}
`;
