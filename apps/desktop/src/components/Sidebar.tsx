import { useEffect, useRef, useState, type ReactNode } from "react";
import { IS_REMOTE } from "../remote/mode";
import { PhoneAppSettings } from "../remote/PhoneAppSettings";
import type { Provider } from "@thingmaker/contracts";
import { PROVIDERS, PROVIDER_LABELS } from "@thingmaker/contracts";
import { useStore, sessionTitle, basenameOf as basename } from "../store";
import { api } from "../ipc";
import { ProviderBadge } from "./ProviderMark";
import { windowName } from "./UsageLine";
import { t } from "../i18n";
import {
  IconChevron,
  IconDots,
  IconFolder,
  IconGear,
  IconAgents,
  IconKey,
  IconMessage,
  IconPin,
  IconPinFilled,
  IconPlus,
  IconRefresh,
  IconSidebar,
  IconX,
} from "./icons";

function AttentionDot({ kind, running, exited }: { kind: string; running: boolean; exited: boolean }) {
  const title =
    kind === "needs_input" ? t("needs your input") : kind === "completed" ? t("finished") : kind === "failed" ? t("failed or exited") : running ? t("running") : exited ? t("exited") : t("idle");
  const cls = kind !== "none" ? `dot dot-${kind}` : running ? "dot dot-running" : exited ? "dot dot-exited" : "dot dot-idle";
  return <span aria-label={title} className={cls} title={title} />;
}

/** Untitled sessions show a short, stable name instead of the raw id. */
/** Two letters for the row, so the provider is visible without a second line. */

function storedLabel(id: string, title: string | undefined): string {
  if (title && title !== id) return title;
  return t("Session {id}", { id: id.replace(/^(cx|tm)-/, "").slice(0, 8) });
}

function relative(iso: string | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return t("now");
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** One session as the sidebar sees it, whether attached or only on disk. */
type Row = {
  workspaceId: string;
  project: string;
  /** The agent's session id: the identity the pin and archive flags are keyed
   *  by. Null on a live session whose id the agent has not reported yet,
   *  which is the one case where pinning has nothing stable to write against. */
  id: string | null;
  /** Which subscription the session spends. */
  provider: Provider;
  label: string;
  /** Set when the session is attached; drives the live status dot. */
  liveId: string | null;
  attention: string;
  running: boolean;
  exited: boolean;
  updated: string | undefined;
  trusted: boolean;
  pinned: boolean;
  archived: boolean;
  /** The orchestrator's agent session id, for a worker a `delegate` opened. */
  parent: string | null;
};

/** Siblings without a wrapper element: rows stay direct children of the list. */
function SessionGroup({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** Workers listed right under the session they work for; a worker whose
 *  orchestrator is not in the list stands on its own. */
export function nestWorkers<T extends { id: string | null; parent: string | null }>(rows: T[]): T[] {
  const ids = new Set(rows.map((row) => row.id));
  const out: T[] = [];
  for (const row of rows) {
    if (row.parent && ids.has(row.parent)) continue;
    out.push(row);
    if (row.id) out.push(...rows.filter((child) => child.parent === row.id));
  }
  return out;
}

function SessionRow({ row, showProject, onMenu, renaming, onRename }: { row: Row; showProject?: boolean; onMenu: (row: Row, at: { x: number; y: number }) => void; renaming: boolean; onRename: (title: string | null) => void }) {
  const view = useStore((s) => s.view);
  const selectSession = useStore((s) => s.selectSession);
  const openSession = useStore((s) => s.openSession);
  const pinSession = useStore((s) => s.pinSession);
  const sessionOrder = useStore((s) => s.sessionOrder);
  const [draft, setDraft] = useState(row.label);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) {
      setDraft(row.label);
      input.current?.focus();
      input.current?.select();
    }
  }, [renaming, row.label]);

  const active = view.kind === "session" && row.liveId !== null && view.sessionId === row.liveId;
  const index = row.liveId ? sessionOrder.indexOf(row.liveId) : -1;
  const shortcut = index >= 0 && index < 9 ? ` (⌘${index + 1})` : "";
  const open = () => {
    if (row.liveId) selectSession(row.liveId);
    else if (row.id) void openSession(row.workspaceId, { mode: "resume", session_id: row.id });
  };

  if (renaming) {
    return (
      <li className="session-li">
        <form
          className="session-rename"
          onSubmit={(event) => {
            event.preventDefault();
            onRename(draft);
          }}
        >
          <input
            aria-label={t("Rename {name}", { name: row.label })}
            className="input session-rename-input"
            onBlur={() => onRename(draft)}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onRename(null);
              }
            }}
            placeholder={t("Session name (blank restores the original)")}
            ref={input}
            value={draft}
          />
        </form>
      </li>
    );
  }

  return (
    <li className={`session-li ${row.archived ? "archived" : ""} ${row.parent ? "session-worker" : ""}`} onContextMenu={(event) => {
      event.preventDefault();
      onMenu(row, { x: event.clientX, y: event.clientY });
    }}>
      <button
        aria-current={active ? "page" : undefined}
        className={`session-row ${row.liveId ? "" : "stored"} ${active ? "selected" : ""}`}
        disabled={!row.liveId && !row.trusted}
        onClick={open}
        title={row.liveId ? `${row.id}${shortcut}` : row.trusted ? t("Resume {id}", { id: row.id ?? "" }) : t("Trust the workspace to resume")}
        type="button"
      >
        {row.liveId ? (
          <AttentionDot exited={row.exited} kind={row.attention} running={row.running} />
        ) : (
          <span className="session-glyph">
            <IconMessage size={14} />
          </span>
        )}
        <span className="session-label">
          <span className="sidebar-title">{row.label}</span>
          {showProject && <span className="session-project">{row.project}</span>}
        </span>
        <ProviderBadge provider={row.provider} title={t("Runs on {provider}", { provider: row.provider === "gemini" ? "Gemini (Antigravity)" : PROVIDER_LABELS[row.provider] })} />
        <span className="row-meta">{row.running ? t("running") : row.exited ? t("exited") : relative(row.updated)}</span>
      </button>
      <span className="row-actions">
        <button
          aria-label={row.pinned ? t("Unpin {name}", { name: row.label }) : t("Pin {name}", { name: row.label })}
          aria-pressed={row.pinned}
          className={`icon-button icon-button-xs row-action ${row.pinned ? "row-action-on" : ""}`}
          disabled={row.id === null}
          onClick={() => row.id && void pinSession(row.workspaceId, row.id, !row.pinned)}
          title={row.id === null ? t("Waiting for the agent to report this session's id") : row.pinned ? t("Unpin from the top of the list") : t("Pin to the top of the list")}
          type="button"
        >
          {row.pinned ? <IconPinFilled size={14} /> : <IconPin size={14} />}
        </button>
        <button
          aria-haspopup="menu"
          aria-label={t("Actions for {name}", { name: row.label })}
          className="icon-button icon-button-xs row-action"
          disabled={row.id === null}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            onMenu(row, { x: box.right, y: box.bottom });
          }}
          title={t("Rename, pin, open folder")}
          type="button"
        >
          <IconDots size={14} />
        </button>
      </span>
    </li>
  );
}

/** Right-click (or the ⋯ action) menu for one session row. */
function RowMenu({ row, at, onClose, onRename }: { row: Row; at: { x: number; y: number }; onClose: () => void; onRename: () => void }) {
  const pinSession = useStore((s) => s.pinSession);
  const archiveSession = useStore((s) => s.archiveSession);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onDown = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // Capture, so a click anywhere closes the menu before it activates a row.
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const act = (run: () => void) => () => {
    run();
    onClose();
  };
  // The folder the session works in.
  const root = useStore((s) => s.workspaces.find((workspace) => workspace.id === row.workspaceId)?.canonicalRoot);
  const setError = useStore((s) => s.setError);

  return (
    <div
      className="context-menu"
      ref={menu}
      role="menu"
      // Keep the menu on screen when the row is near the bottom edge.
      style={{ left: Math.min(at.x, window.innerWidth - 200), top: Math.min(at.y, window.innerHeight - 170) }}
    >
      <button className="context-item" onClick={act(onRename)} role="menuitem" type="button">
        {t("Rename…")}
      </button>
      <button className="context-item" onClick={act(() => row.id && void pinSession(row.workspaceId, row.id, !row.pinned))} role="menuitem" type="button">
        {row.pinned ? t("Unpin") : t("Pin to top")}
      </button>
      {!row.liveId && (
        <button className="context-item" onClick={act(() => row.id && void archiveSession(row.workspaceId, row.id, !row.archived))} role="menuitem" type="button">
          {row.archived ? t("Restore") : t("Archive")}
        </button>
      )}
      {root && (
        <button className="context-item" onClick={act(() => void api.revealInFinder(root).catch(setError))} role="menuitem" type="button">
          {t("Open folder")}
        </button>
      )}
      {row.id && (
        <button className="context-item" onClick={act(() => void navigator.clipboard?.writeText(row.id as string))} role="menuitem" type="button">
          {t("Copy session id")}
        </button>
      )}
    </div>
  );
}

/** A sidebar layout choice remembered on this machine; a convenience, so failures are ignored. */
function remembered<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : (JSON.parse(stored) as T);
  } catch {
    return fallback;
  }
}

function remember(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Remembering is a convenience.
  }
}

export function Sidebar() {
  const workspaces = useStore((s) => s.workspaces);
  const inspections = useStore((s) => s.inspections);
  const sessions = useStore((s) => s.sessions);
  const sessionOrder = useStore((s) => s.sessionOrder);
  const view = useStore((s) => s.view);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const openSession = useStore((s) => s.openSession);
  const loadRecords = useStore((s) => s.loadRecords);
  const addWorkspaceByPicker = useStore((s) => s.addWorkspaceByPicker);
  const records = useStore((s) => s.records);
  const showHidden = useStore((s) => s.showHidden);
  const setShowHidden = useStore((s) => s.setShowHidden);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const setView = useStore((s) => s.setView);
  const loadProviders = useStore((s) => s.loadProviders);
  const updatesOut = useStore((s) => Object.values(s.providerVersions ?? {}).filter((version) => version?.updateAvailable).length);
  const loadSettings = useStore((s) => s.loadSettings);
  const providers = useStore((s) => s.providers);
  const usage = useStore((s) => s.usage);
  // Folded workspaces, and the Pinned group, stay folded across restarts.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => remembered("thingmaker.sidebar.collapsed", {}));
  const [pinnedCollapsed, setPinnedCollapsed] = useState(() => remembered("thingmaker.sidebar.pinnedCollapsed", false));
  const [menu, setMenu] = useState<{ row: Row; at: { x: number; y: number } } | null>(null);
  /** Agent session id of the row being renamed inline. */
  const [renaming, setRenaming] = useState<string | null>(null);
  // Orchestrators whose workers are shown. Folded by default: a long run
  // opens dozens, and they would bury every other session. Remembered on
  // this machine.
  // Finished workers inside an open team, folded unless asked for.
  const [openFinished, setOpenFinished] = useState<Record<string, boolean>>({});
  const [openTeams, setOpenTeams] = useState<Record<string, boolean>>(() => remembered("thingmaker.sidebar.openTeams", {}));
  const toggleTeam = (id: string) => {
    const next = { ...openTeams, [id]: !openTeams[id] };
    setOpenTeams(next);
    remember("thingmaker.sidebar.openTeams", next);
  };
  const renameSession = useStore((s) => s.renameSession);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const [removing, setRemoving] = useState<{ id: string; name: string; live: number } | null>(null);

  /** Rows per workspace, so the pinned group can be assembled across them. */
  const groups = workspaces.map((workspace) => {
    const inspection = inspections[workspace.id];
    const trusted = inspection?.record.trustState === "trusted_local" && !inspection.trustStale;
    const project = basename(workspace.displayPath);
    const live = sessionOrder.map((id) => sessions[id]).filter((s): s is NonNullable<typeof s> => !!s && s.workspaceId === workspace.id);
    const liveIds = new Set(live.map((s) => s.handle.id));
    const workspaceRecords = records[workspace.id] ?? [];
    const archived = new Set(workspaceRecords.filter((r) => r.archiveState === "archived").map((r) => r.agentSessionId));
    const pinned = new Set(workspaceRecords.filter((r) => r.pinned).map((r) => r.agentSessionId));
    // A rename is a desktop overlay, so it wins over the derived title.
    const overlay = new Map(workspaceRecords.filter((r) => r.titleOverlay).map((r) => [r.agentSessionId, r.titleOverlay as string]));
    const agentIdOf = new Map(workspaceRecords.map((r) => [r.id, r.agentSessionId]));
    const parentOf = new Map(
      workspaceRecords.filter((r) => r.parentSessionId).map((r) => [r.agentSessionId, agentIdOf.get(r.parentSessionId as string) ?? null] as const),
    );

    const liveRows: Row[] = live.map((session) => ({
      workspaceId: workspace.id,
      project,
      id: session.snapshot.agentSessionId,
      provider: session.snapshot.provider,
      label: (session.snapshot.agentSessionId && overlay.get(session.snapshot.agentSessionId)) || sessionTitle(session, workspaceRecords),
      liveId: session.handle.id,
      attention: session.attention,
      running: session.projection.foreground === "running" || session.projection.foreground === "cancelling" || session.projection.foreground === "awaiting_user",
      exited: session.projection.process === "exited",
      updated: undefined,
      trusted,
      pinned: session.snapshot.agentSessionId !== null && pinned.has(session.snapshot.agentSessionId),
      archived: false,
      parent: (session.snapshot.agentSessionId && parentOf.get(session.snapshot.agentSessionId)) || null,
    }));

    // Every session the desktop has opened is in its own records, whichever
    // provider ran it, so the records are the list. A live attachment is
    // listed once, as live; a session whose transcript the agent no longer
    // has is a tombstone and is left out.
    const liveAgentIds = new Set(live.map((session) => session.snapshot.agentSessionId).filter((id): id is string => !!id));
    const storedRows: Row[] = workspaceRecords
      .filter((record) => !liveAgentIds.has(record.agentSessionId) && record.archiveState !== "unavailable")
      .map((record) => ({
        workspaceId: workspace.id,
        project,
        id: record.agentSessionId,
        provider: record.provider,
        // The rename, else the title the session kept after it closed.
        label: overlay.get(record.agentSessionId) ?? storedLabel(record.agentSessionId, record.autoTitle || undefined),
        liveId: null,
        attention: "none",
        running: false,
        exited: false,
        updated: record.lastSeen ? new Date(record.lastSeen).toISOString() : undefined,
        trusted,
        pinned: pinned.has(record.agentSessionId),
        archived: archived.has(record.agentSessionId),
        parent: parentOf.get(record.agentSessionId) ?? null,
      }));

    const rows = [...liveRows, ...storedRows];
    return {
      workspace,
      inspection,
      trusted,
      project,
      liveCount: live.length,
      // Pinned sessions are listed once, in the Pinned group at the top.
      unpinned: nestWorkers(rows.filter((row) => !row.pinned && !row.archived)),
      pinnedRows: rows.filter((row) => row.pinned && !row.archived),
      archivedRows: rows.filter((row) => row.archived),
    };
  });

  const allPinned = groups.flatMap((group) => group.pinnedRows);
  const manyProjects = workspaces.length > 1;

  return (
    <nav aria-label={t("Workspaces and sessions")} className="sidebar">
      <div className="sidebar-top" data-tauri-drag-region>
        <button aria-label={t("Hide sidebar (⌘B)")} className="icon-button remote-hidden" onClick={toggleSidebar} title={t("Hide sidebar (⌘B)")} type="button">
          <IconSidebar />
        </button>
        <span className="sidebar-brand" data-tauri-drag-region>
          <img className="brand-icon" src={`${import.meta.env.BASE_URL}thingmaker-icon.png`} alt="" draggable={false} />
          ThingMaker
        </span>
        <button aria-label={t("Add workspace (⌘O)")} className="icon-button remote-hidden" onClick={() => void addWorkspaceByPicker()} title={t("Add workspace (⌘O)")} type="button">
          <IconPlus />
        </button>
      </div>

      <div className="sidebar-body">
        {workspaces.length === 0 && (
          <button className="sidebar-empty" onClick={() => void addWorkspaceByPicker()} type="button">
            <IconFolder size={18} />
            <span>
              <strong>{t("Add a project folder")}</strong>
              <br />
              <span className="muted small">{t("Inspect it, trust it, then start a session.")}</span>
            </span>
          </button>
        )}

        {allPinned.length > 0 && (
          <section className="ws-group pinned-group">
            <div className="group-header">
              <button aria-label={pinnedCollapsed ? t("Expand") : t("Collapse")} className="icon-button icon-button-xs" onClick={() => {
                  setPinnedCollapsed(!pinnedCollapsed);
                  remember("thingmaker.sidebar.pinnedCollapsed", !pinnedCollapsed);
                }} type="button">
                <IconChevron open={!pinnedCollapsed} size={14} />
              </button>
              <span className="group-label">
                <IconPinFilled size={12} /> {t("Pinned")}
              </span>
              <span className="group-count">{allPinned.length}</span>
            </div>
            {!pinnedCollapsed && (
              <ul className="sidebar-sessions">
                {allPinned.map((row) => (
                  <SessionRow
                    key={`pinned-${row.workspaceId}-${row.liveId ?? row.id}`}
                    onMenu={(target, at) => setMenu({ row: target, at })}
                    onRename={(title) => {
                      setRenaming(null);
                      if (title !== null && row.id) void renameSession(row.workspaceId, row.id, title);
                    }}
                    renaming={renaming === row.id}
                    row={row}
                    showProject={manyProjects}
                  />
                ))}
              </ul>
            )}
          </section>
        )}

        {groups.map(({ workspace, inspection, trusted, project, liveCount, unpinned, pinnedRows, archivedRows }) => {
          const selected = view.kind === "workspace" && view.workspaceId === workspace.id;
          const isCollapsed = collapsed[workspace.id] ?? false;
          return (
            <section className="ws-group" key={workspace.id}>
              <div className={`ws-header ${selected ? "selected" : ""}`}>
                <button aria-label={isCollapsed ? t("Expand") : t("Collapse")} className="icon-button icon-button-xs" onClick={() => {
                    const next = { ...collapsed, [workspace.id]: !isCollapsed };
                    setCollapsed(next);
                    remember("thingmaker.sidebar.collapsed", next);
                  }} type="button">
                  <IconChevron open={!isCollapsed} size={14} />
                </button>
                <button aria-current={selected ? "page" : undefined} className="ws-name" onClick={() => void selectWorkspace(workspace.id)} title={workspace.displayPath} type="button">
                  <span className="ws-glyph">
                    <IconFolder size={14} />
                  </span>
                  <span className="sidebar-title">{project}</span>
                  <span className={`trust-dot ${trusted ? "trust-ok" : "trust-warn"}`} title={inspection?.trustStale ? t("configuration changed: re-review") : trusted ? t("trusted local") : t("not trusted yet")} />
                </button>
                <span className="ws-actions">
                  <button
                    aria-label={t("Refresh sessions")}
                    className="icon-button icon-button-xs"
                    onClick={() => void loadRecords(workspace.id)}
                    title={t("Refresh the session list")}
                    type="button"
                  >
                    <IconRefresh size={14} />
                  </button>
                  <button
                    aria-label={t("New session")}
                    className="icon-button icon-button-xs"
                    disabled={!trusted}
                    onClick={() => void openSession(workspace.id, { mode: "new" })}
                    title={trusted ? t("New session (⌘N)") : t("Trust the workspace to start a session")}
                    type="button"
                  >
                    <IconPlus size={14} />
                  </button>
                  <button
                    aria-label={t("Remove workspace from the list")}
                    className="icon-button icon-button-xs remote-hidden"
                    onClick={() => setRemoving({ id: workspace.id, name: project, live: liveCount })}
                    title={t("Remove from ThingMaker (files and agent transcripts stay on disk)")}
                    type="button"
                  >
                    <IconX size={14} />
                  </button>
                </span>
              </div>
              {!isCollapsed && (
                <ul className="sidebar-sessions">
                  {unpinned.map((row) => {
                    const children = row.id ? unpinned.filter((child) => child.parent === row.id) : [];
                    // A worker shows only while its orchestrator's team is
                    // open; one whose orchestrator is not listed stands alone.
                    if (row.parent && unpinned.some((parent) => parent.id === row.parent) && !openTeams[row.parent]) return null;
                    // A finished worker folds away: the live ones are what to watch.
                    if (row.parent && !row.running && unpinned.some((parent) => parent.id === row.parent) && !openFinished[row.parent]) return null;
                    const running = children.filter((child) => child.running).length;
                    const finished = children.length - running;
                    return (
                      <SessionGroup key={row.liveId ?? row.id}>
                        <SessionRow
                          onMenu={(target, at) => setMenu({ row: target, at })}
                          onRename={(title) => {
                            setRenaming(null);
                            if (title !== null && row.id) void renameSession(row.workspaceId, row.id, title);
                          }}
                          renaming={renaming === row.id}
                          row={row}
                        />
                        {children.length > 0 && row.id && (
                          <li className="session-li session-worker">
                            <button className="disclosure small" onClick={() => toggleTeam(row.id as string)} type="button">
                              <IconChevron open={!!openTeams[row.id]} size={12} /> {children.length === 1 ? t("1 worker") : t("{count} workers", { count: children.length })}
                              {running > 0 ? ` · ${t("{count} running", { count: running })}` : ""}
                            </button>
                            {openTeams[row.id] && finished > 0 && (
                              <button className="link small sidebar-finished" onClick={() => setOpenFinished({ ...openFinished, [row.id as string]: !openFinished[row.id as string] })} type="button">
                                {openFinished[row.id] ? t("hide finished") : t("show {count} finished", { count: finished })}
                              </button>
                            )}
                          </li>
                        )}
                      </SessionGroup>
                    );
                  })}
                  {unpinned.length === 0 && pinnedRows.length === 0 && archivedRows.length === 0 && (
                    <li className="small muted sidebar-note">{trusted ? t("No sessions yet.") : t("Select the workspace to open it.")}</li>
                  )}
                  {unpinned.length === 0 && pinnedRows.length > 0 && (
                    <li className="small muted sidebar-note">
                      {pinnedRows.length === 1 ? t("Its only session is pinned above.") : t("All {count} sessions are pinned above.", { count: pinnedRows.length })}
                    </li>
                  )}
                  {archivedRows.length > 0 && (
                    <li>
                      <button className="disclosure" onClick={() => setShowHidden(!showHidden)} type="button">
                        <IconChevron open={showHidden} size={12} /> {t("Archived ({count})", { count: archivedRows.length })}
                      </button>
                    </li>
                  )}
                  {showHidden &&
                    archivedRows.map((row) => (
                      <SessionRow
                        key={`archived-${row.id}`}
                        onMenu={(target, at) => setMenu({ row: target, at })}
                        onRename={(title) => {
                          setRenaming(null);
                          if (title !== null && row.id) void renameSession(row.workspaceId, row.id, title);
                        }}
                        renaming={renaming === row.id}
                        row={row}
                      />
                    ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {menu && <RowMenu at={menu.at} onClose={() => setMenu(null)} onRename={() => setRenaming(menu.row.id)} row={menu.row} />}

      {removing && (
        <div aria-modal="true" className="modal-backdrop" role="dialog">
          <div className="modal">
            <h2>{t("Remove {name} from ThingMaker?", { name: removing.name })}</h2>
            <p className="small">
              {t(
                "This forgets the workspace here: its trust decision, archive flags, review baselines and desktop records. The folder, its files and the agents' own transcripts (~/.claude, ~/.codex) are not touched.",
              )}
            </p>
            {removing.live > 0 && (
              <p className="small chip-warn">
                {removing.live === 1
                  ? t("1 session is still attached. Stop it first.")
                  : t("{count} sessions are still attached. Stop them first.", { count: removing.live })}
              </p>
            )}
            <div className="row wrap">
              <button
                className="button button-warn"
                disabled={removing.live > 0}
                onClick={() => {
                  void removeWorkspace(removing.id);
                  setRemoving(null);
                }}
                type="button"
              >
                {t("Remove workspace")}
              </button>
              <button className="button" onClick={() => setRemoving(null)} type="button">
                {t("Cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="sidebar-footer">
        {PROVIDERS.map((provider) => {
          const snapshot = usage[provider];
          if (!snapshot?.primary) return null;
          const windows = [snapshot.primary, snapshot.secondary].filter((w): w is NonNullable<typeof w> => !!w);
          return (
            <div className="status-line small muted" key={provider} title={t("{provider}, account-wide. Details in a session's Context tab.", { provider: `${PROVIDER_LABELS[provider]}${snapshot.planType ? ` (${snapshot.planType})` : ""}` })}>
              {PROVIDER_LABELS[provider]} · {windows.map((w) => t("{window} {percent}% left", { window: windowName(w.windowSeconds), percent: Math.max(0, 100 - Math.round(w.usedPercent)) })).join(" · ")}
              {snapshot.limitReached ? ` · ${t("limit reached")}` : ""}
            </div>
          );
        })}
        {IS_REMOTE && <PhoneAppSettings />}
        <div className="row remote-hidden">
          <button
            className={`icon-button ${view.kind === "signin" ? "on" : ""}`}
            onClick={() => {
              setView({ kind: "signin" });
              void loadProviders();
            }}
            title={
              updatesOut === 1
                ? t("Providers (⌘,): 1 update available")
                : updatesOut > 1
                  ? t("Providers (⌘,): {count} updates available", { count: updatesOut })
                  : t("Providers (⌘,)")
            }
            type="button"
          >
            <IconKey />
            {updatesOut > 0 && <span aria-label={t("update available")} className="badge-dot" />}
          </button>
          <button
            className={`icon-button ${view.kind === "teams" ? "on" : ""}`}
            onClick={() => setView({ kind: "teams" })}
            title={t("Teams: orchestrator and worker presets")}
            type="button"
          >
            <IconAgents />
          </button>
          <button
            className={`icon-button ${view.kind === "settings" ? "on" : ""}`}
            onClick={() => {
              setView({ kind: "settings" });
              void loadSettings();
            }}
            title={t("Settings (⌘;)")}
            type="button"
          >
            <IconGear />
          </button>
        </div>
      </div>
    </nav>
  );
}
