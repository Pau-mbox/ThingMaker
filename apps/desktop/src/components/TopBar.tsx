/**
 * Unified top bar: lives in the overlay title-bar area (macOS traffic lights
 * sit over the sidebar), is draggable, and carries the current view's title
 * plus global actions. Runtime facts moved to the sidebar footer.
 */
import { useEffect } from "react";
import { basenameOf, sessionTitle, useStore } from "../store";
import { IconBranch, IconCommand, IconExport, IconPlug, IconSidebar } from "./icons";

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
    title = workspace ? basenameOf(workspace.displayPath) : "Workspace";
    subtitle = workspace?.displayPath ?? null;
  } else if (view.kind === "signin") title = "Sign-in";
  else if (view.kind === "settings") title = "Settings";
  else if (view.kind === "teams") title = "Teams";
  else if (view.kind === "integrations") title = "Integrations";

  return (
    <header className={`topbar ${sidebarCollapsed ? "topbar-inset" : ""}`} data-tauri-drag-region>
      {sidebarCollapsed && (
        <button aria-label="Show sidebar (⌘B)" className="icon-button" onClick={toggleSidebar} title="Show sidebar (⌘B)" type="button">
          <IconSidebar />
        </button>
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
            title={`Git ${repo.detached ? "detached at" : "branch"} ${repo.head}${repo.upstream ? ` · tracking ${repo.upstream}` : " · no upstream"}${
              repo.ahead || repo.behind ? ` · ${repo.ahead} ahead, ${repo.behind} behind` : ""
            }\n${repo.root}${view.kind === "session" ? "\nOpen the Changes tab" : ""}`}
            type="button"
          >
            <IconBranch size={13} />
            <span className="branch-name">{repo.head}</span>
            {repo.detached && <span className="branch-flag">detached</span>}
            {repo.ahead > 0 && <span className="branch-count">↑{repo.ahead}</span>}
            {repo.behind > 0 && <span className="branch-count">↓{repo.behind}</span>}
          </button>
        )}
        {view.kind === "session" && (
          <button
            aria-label="Export the transcript as Markdown"
            className="icon-button icon-button-xs topbar-quiet"
            onClick={() => void exportTranscript(view.sessionId)}
            title="Export the transcript as Markdown…"
            type="button"
          >
            <IconExport size={14} />
          </button>
        )}
      </div>
      <div className="topbar-actions">
        <button
          className={`icon-button ${view.kind === "integrations" ? "on" : ""}`}
          onClick={() => setView({ kind: "integrations" })}
          title="MCP, plugins, skills and harnesses (⌘I)"
          type="button"
        >
          <IconPlug />
        </button>
        <button className="icon-button" onClick={() => setPaletteOpen(true)} title="Command palette (⌘K)" type="button">
          <IconCommand />
        </button>
      </div>
    </header>
  );
}
