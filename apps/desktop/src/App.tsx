import { useEffect } from "react";
import { useStore } from "./store";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceView } from "./components/WorkspaceView";
import { SessionPanel } from "./components/SessionPanel";
import { SignInPanel } from "./components/SignInPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { AttentionBanner, CloseRequestDialog, LockedResumeDialog } from "./components/Attention";
import { useKeyboardShortcuts } from "./shortcuts";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { IntegrationsPanel } from "./components/IntegrationsPanel";
import { TeamsView } from "./components/TeamsView";
import { CommandPalette } from "./components/CommandPalette";
import { IconFolder, IconKey } from "./components/icons";

function Welcome() {
  const addWorkspaceByPicker = useStore((s) => s.addWorkspaceByPicker);
  const setView = useStore((s) => s.setView);
  const loadProviders = useStore((s) => s.loadProviders);
  const workspaces = useStore((s) => s.workspaces);
  return (
    <div className="welcome">
      <div className="welcome-card">
        <img className="welcome-brand-icon" src="/thingmaker-icon.png" alt="" draggable={false} />
        <h1>ThingMaker</h1>
        <p className="muted">One desktop for Claude Code and Codex on your own subscriptions: sessions you can observe, steer, review and hand between providers.</p>
        <div className="welcome-actions">
          <button className="button button-primary" onClick={() => void addWorkspaceByPicker()} type="button">
            <IconFolder size={15} /> {workspaces.length === 0 ? "Add a project folder" : "Add another folder"}
          </button>
          <button
            className="button"
            onClick={() => {
              setView({ kind: "signin" });
              void loadProviders();
            }}
            type="button"
          >
            <IconKey size={15} /> Set up providers
          </button>
        </div>
        <dl className="welcome-keys">
          <dt>⌘K</dt>
          <dd>command palette</dd>
          <dt>⌘N</dt>
          <dd>new session in the selected workspace</dd>
          <dt>⌘1–9</dt>
          <dd>switch sessions</dd>
          <dt>⌘B</dt>
          <dd>toggle sidebar</dd>
        </dl>
        <p className="small muted">
          Execution is <strong>Trusted local · host access</strong>: agents' tools run with your full user authority. Review a workspace's executable configuration before
          trusting it.
        </p>
      </div>
    </div>
  );
}

export function App() {
  const bootstrap = useStore((s) => s.bootstrap);
  const error = useStore((s) => s.error);
  const clearError = useStore((s) => s.clearError);
  const busy = useStore((s) => s.busy);
  const view = useStore((s) => s.view);
  const announcement = useStore((s) => s.announcement);
  const reducedMotion = useStore((s) => s.uiPrefs.reducedMotion);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);

  const odysseyPoll = useStore((s) => s.odysseyPoll);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Super Thing's heartbeat. A running goal advances on turn settles; this is what
  // moves a goal that is parked on a usage window, and what picks a run back up
  // after a reload. Ten seconds is fine for a countdown measured in hours.
  useEffect(() => {
    const timer = setInterval(() => void odysseyPoll(), 10_000);
    return () => clearInterval(timer);
  }, [odysseyPoll]);

  useKeyboardShortcuts();

  return (
    <div className={`app ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} data-reduce-motion={reducedMotion === "reduce" ? "true" : undefined}>
      <div aria-live="polite" className="sr-only" role="status">
        {announcement}
      </div>
      <CommandPalette />
      <CloseRequestDialog />
      <LockedResumeDialog />
      <div className="shell">
        {!sidebarCollapsed && (
          <ErrorBoundary label="sidebar">
            <Sidebar />
          </ErrorBoundary>
        )}
        <section className="main">
          <ErrorBoundary label="top bar">
            <TopBar />
          </ErrorBoundary>
          {error && (
            <div className="banner banner-error" role="alert">
              <strong>{error.code}</strong> {error.message}
              <span className="muted"> (retry: {error.retry.replace("_", " ")})</span>
              <button className="link" onClick={clearError} type="button">
                dismiss
              </button>
            </div>
          )}
          {busy && (
            <div className="banner banner-busy" role="status">
              {busy}…
            </div>
          )}
          <ErrorBoundary label="attention banner">
            <AttentionBanner />
          </ErrorBoundary>
          <div className="main-pane">
            <ErrorBoundary key={view.kind === "session" ? view.sessionId : view.kind} label={`${view.kind} view`}>
              {view.kind === "welcome" && <Welcome />}
              {view.kind === "workspace" && <WorkspaceView key={view.workspaceId} workspaceId={view.workspaceId} />}
              {view.kind === "session" && <SessionPanel key={view.sessionId} sessionId={view.sessionId} />}
              {view.kind === "signin" && <SignInPanel />}
              {view.kind === "settings" && <SettingsPanel />}
              {view.kind === "teams" && <TeamsView />}
              {view.kind === "integrations" && <IntegrationsPanel />}
            </ErrorBoundary>
          </div>
        </section>
      </div>
    </div>
  );
}
