import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode; label: string; onReset?: () => void };
type State = { error: Error | null; info: string | null };

/**
 * A renderer defect must never blank the application: native session actors
 * keep running (REC-04), so the UI shows the failure and offers to remount the
 * failed view from a fresh snapshot instead of losing everything.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, info: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.label}] render failure`, error, info.componentStack);
    this.setState({ info: info.componentStack ?? null });
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel" role="alert">
        <h2>This view failed to render</h2>
        <p className="muted small">
          The {this.props.label} hit a renderer defect. Agent sessions are unaffected; the native supervisor still owns them. Copy the
          details below into a bug report, then remount the view.
        </p>
        <pre className="text log">{`${this.state.error.name}: ${this.state.error.message}\n${this.state.error.stack ?? ""}\n${this.state.info ?? ""}`}</pre>
        <button
          className="button button-primary"
          onClick={() => {
            this.setState({ error: null, info: null });
            this.props.onReset?.();
          }}
          type="button"
        >
          Remount view
        </button>
      </div>
    );
  }
}
