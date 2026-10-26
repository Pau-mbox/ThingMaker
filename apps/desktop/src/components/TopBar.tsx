/**
 * Unified top bar: lives in the overlay title-bar area (macOS traffic lights
 * sit over the sidebar), is draggable, and carries the current view's title
 * plus global actions. Runtime facts moved to the sidebar footer.
 */
import { IS_REMOTE } from "../remote/mode";
import { useEffect } from "react";
import { basenameOf, sessionTitle, useStore, viewExists } from "../store";
import { navTarget } from "../navHistory";
import { IconBack, IconBranch, IconCommand, IconExport, IconForward, IconPlug, IconSidebar } from "./icons";
import { t } from "../i18n";

export function TopBar() {
  const view = useStore((s) => s.view);
  const sessions = useStore((s) => s.sessions);
  const workspaces = useStore((s) => s.workspaces);
  const setView = useStore((s) => s.setView);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const repoInfo = useStore((s) => s.repoInfo);
  const loadRepoInfo = useStore((s) => s.loadRepoInfo);
  const setSessionTab = useStore((s) => s.setSessionTab);
  const exportTranscript = useStore((s) => s.exportTranscript);
  const records = useStore((s) => s.records);
  const navigate = useStore((s) => s.navigate);
  const canGoBack = useStore((s) => navTarget(s.navHistory, s.navIndex, -1, (v) => viewExists(s, v)) !== null);
  const canGoForward = useStore((s) => navTarget(s.navHistory, s.navIndex, 1, (v) => viewExists(s, v)) !== null);

  // The workspace whose git head the bar describes: the focused session's, or
  // the selected workspace.
  const workspaceId = view.kind === "session" ? sessions[view.sessionId]?.workspaceId : view.kind === "workspace" ? view.workspaceId : undefined;
  const repo = workspaceId === undefined ? undefined : repoInfo[workspaceId];

  useEffect(() => {
    // `undefined` means never read; `null` means read and not a repository.
    if (workspaceId && repoInfo[workspaceId] === undefined) void loadRepoInfo(workspaceId);
  }, [workspaceId, repoInfo, loadRepoInfo]);

  let title = "ThingMaker";
  let subtitle: string | null = null;
  if (view.kind === "session") {
    const session = sessions[view.sessionId];
    if (session) {
      title = sessionTitle(session, records[session.workspaceId]);
      const workspace = workspaces.find((w) => w.id === session.workspaceId);
      subtitle = workspace ? basenameOf(workspace.displayPath) : null;
    }
  } else if (view.kind === "workspace") {
    const workspace = workspaces.find((w) => w.id === view.workspaceId);
    title = workspace ? basenameOf(workspace.displayPath) : t("Workspace");
    subtitle = workspace?.displayPath ?? null;
  } else if (view.kind === "signin") title = t("Sign-in");
  else if (view.kind === "settings") title = t("Settings");
  else if (view.kind === "teams") title = t("Teams");
  else if (view.kind === "integrations") title = t("Integrations");

  return (
    <header className={`topbar ${sidebarCollapsed && !IS_REMOTE ? "topbar-inset" : ""}`} data-tauri-drag-region>
      {IS_REMOTE && (
        <button aria-label={t("Workspaces and sessions")} className="icon-button" onClick={toggleSidebar} type="button">
          <IconSidebar />
        </button>
      )}
      {sidebarCollapsed && !IS_REMOTE && (
        <button aria-label={t("Show sidebar (⌘B)")} className="icon-button" onClick={toggleSidebar} title={t("Show sidebar (⌘B)")} type="button">
          <IconSidebar />
        </button>
      )}
      {!IS_REMOTE && (
        <div className="topbar-nav">
          <button aria-label={t("Back")} className="icon-button" disabled={!canGoBack} onClick={() => navigate(-1)} title={t("Back (⌘[)")} type="button">
            <IconBack />
          </button>
          <button aria-label={t("Forward")} className="icon-button" disabled={!canGoForward} onClick={() => navigate(1)} title={t("Forward (⌘])")} type="button">
            <IconForward />
          </button>
        </div>
      )}
      <div className="topbar-title" data-tauri-drag-region>
        <span className="topbar-name" data-tauri-drag-region>
          {title}
        </span>
        {subtitle && (
          <span className="topbar-sub muted small" data-tauri-drag-region>
            {subtitle}
          </span>
        )}
        {repo && (
          <button
            className="branch-chip"
            disabled={view.kind !== "session"}
            onClick={() => setSessionTab("changes")}
            title={`${[
              repo.detached ? t("Git detached at {head}", { head: repo.head }) : t("Git branch {head}", { head: repo.head }),
              repo.upstream ? t("tracking {upstream}", { upstream: repo.upstream }) : t("no upstream"),
              ...(repo.ahead || repo.behind ? [t("{ahead} ahead, {behind} behind", { ahead: repo.ahead, behind: repo.behind })] : []),
            ].join(" · ")}\n${repo.root}${view.kind === "session" ? `\n${t("Open the Changes tab")}` : ""}`}
            type="button"
          >
            <IconBranch size={13} />
            <span className="branch-name">{repo.head}</span>
            {repo.detached && <span className="branch-flag">{t("detached")}</span>}
            {repo.ahead > 0 && <span className="branch-count">↑{repo.ahead}</span>}
            {repo.behind > 0 && <span className="branch-count">↓{repo.behind}</span>}
          </button>
        )}
        {view.kind === "session" && (
          <button
            aria-label={t("Export the transcript as Markdown")}
            className="icon-button icon-button-xs topbar-quiet remote-hidden"
            onClick={() => void exportTranscript(view.sessionId)}
            title={t("Export the transcript as Markdown…")}
            type="button"
          >
            <IconExport size={14} />
          </button>
        )}
      </div>
      <div className="topbar-actions">
        <button className="button small" title={t("Enter Chill mode (⌘⇧C)")} onClick={() => useStore.getState().setChillMode(true)} type="button">☾ Chill</button>
        <button
          className={`icon-button remote-hidden ${view.kind === "integrations" ? "on" : ""}`}
          onClick={() => setView({ kind: "integrations" })}
          title={t("MCP, plugins, skills and harnesses (⌘I)")}
          type="button"
        >
          <IconPlug />
        </button>
        <button className="icon-button remote-hidden" onClick={() => setPaletteOpen(true)} title={t("Command palette (⌘K)")} type="button">
          <IconCommand />
        </button>
      </div>
    </header>
  );
}
