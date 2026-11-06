import { useEffect, useRef, useState, type ReactNode } from "react";
import { IS_REMOTE } from "../remote/mode";
import { PhoneAppSettings } from "../remote/PhoneAppSettings";
import type { Provider } from "@thingmaker/contracts";
import { PROVIDERS, PROVIDER_LABELS } from "@thingmaker/contracts";
import { useStore, sessionTitle, basenameOf as basename } from "../store";
import { api } from "../ipc";
import { ProviderBadge } from "./ProviderMark";
import { UsageMeter } from "./UsageMeter";
import { t } from "../i18n";
import {
  IconChevron,
  IconDots,
  IconFolder,
  IconGear,
  IconAgents,
  IconKey,
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
  /** The agent session id it is listed under: the orchestrator, for a worker
   *  a `delegate` opened; the session it was copied from, for a fork. */
  parent: string | null;
  /** A fork: a nested session of its own, not a worker. */
  fork: boolean;
};

/** Siblings without a wrapper element: rows stay direct children of the list. */
function SessionGroup({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** Workers and forks listed right under the session they belong to, at any
 *  depth (a fork of a fork); one whose parent is not in the list stands on
 *  its own. */
export function nestWorkers<T extends { id: string | null; parent: string | null }>(rows: T[]): T[] {
  const ids = new Set(rows.map((row) => row.id));
  const out: T[] = [];
  const placed = new Set<T>();
  const place = (row: T) => {
    if (placed.has(row)) return;
    placed.add(row);
    out.push(row);
    if (row.id) for (const child of rows) if (child.parent === row.id) place(child);
  };
  for (const row of rows) if (!(row.parent && ids.has(row.parent))) place(row);
  return out;
}

function SessionRow({
  row,
  showProject,
  onMenu,
  renaming,
  onRename,
  depth = 0,
}: {
  row: Row;
  showProject?: boolean;
  onMenu: (row: Row, at: { x: number; y: number }) => void;
  renaming: boolean;
  onRename: (title: string | null) => void;
  /** How deep it is nested: under a session, a fork of a fork, … */
  depth?: number;
}) {
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
    <li
      className={`session-li ${row.archived ? "archived" : ""} ${depth > 0 ? (row.fork ? "session-nested" : "session-worker") : ""}`}
      style={depth > 0 ? { marginLeft: 14 * depth } : undefined}
      onContextMenu={(event) => {
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
        {/* The provider leads the row; an open session's state sits on its corner. */}
        <span className={`session-lead ${row.liveId ? "" : "session-lead-stored"}`}>
          <ProviderBadge provider={row.provider} title={t("Runs on {provider}", { provider: row.provider === "gemini" ? "Gemini (Antigravity)" : PROVIDER_LABELS[row.provider] })} />
          {row.liveId && <AttentionDot exited={row.exited} kind={row.attention} running={row.running} />}
        </span>
        <span className="session-label">
          <span className="sidebar-title">{row.label}</span>
          {showProject && <span className="session-project">{row.project}</span>}
        </span>
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
function RowMenu({ row, at, onClose, onRename, parentLabel }: { row: Row; at: { x: number; y: number }; onClose: () => void; onRename: () => void; parentLabel: string | null }) {
  const pinSession = useStore((s) => s.pinSession);
  const archiveSession = useStore((s) => s.archiveSession);
  const forkSession = useStore((s) => s.forkSession);
  const nestSession = useStore((s) => s.nestSession);
  const stopAndArchive = useStore((s) => s.stopAndArchive);
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
      {row.id && (
        <button
          className="context-item"
          onClick={act(() => row.id && void forkSession({ workspaceId: row.workspaceId, agentSessionId: row.id, provider: row.provider, ...(row.liveId ? { key: row.liveId } : {}) }))}
          role="menuitem"
          title={t("A copy of this conversation in a new session, nested under this one. This one stays as it is.")}
          type="button"
        >
          {t("Fork")}
        </button>
      )}
      {row.id && (
        <button
          className="context-item"
          onClick={act(() => row.id && void forkSession({ workspaceId: row.workspaceId, agentSessionId: row.id, provider: row.provider, ...(row.liveId ? { key: row.liveId } : {}) }, undefined, { worktree: true }))}
          role="menuitem"
          title={t("The same copy, working in a Git worktree of its own: a new branch from here, with your uncommitted changes carried over.")}
          type="button"
        >
          {t("Fork into a worktree")}
        </button>
      )}
      {row.id && row.fork && row.parent && (
        <button className="context-item" onClick={act(() => row.id && void nestSession(row.workspaceId, row.id, null))} role="menuitem" type="button">
          {parentLabel ? t("Move out of “{name}”", { name: parentLabel }) : t("Move out to the top level")}
        </button>
      )}
      <button className="context-item" onClick={act(() => row.id && void pinSession(row.workspaceId, row.id, !row.pinned))} role="menuitem" type="button">
        {row.pinned ? t("Unpin") : t("Pin to top")}
      </button>
      {row.id && (
        <button
          className="context-item"
          onClick={act(() => row.id && void (row.archived ? archiveSession(row.workspaceId, row.id, false) : stopAndArchive(row.workspaceId, row.id, row.liveId ?? undefined)))}
          role="menuitem"
          title={row.archived ? undefined : row.liveId ? t("Stops this session and moves it to Archived. Its transcript stays on disk.") : t("Moves this session to Archived. Its transcript stays on disk.")}
          type="button"
        >
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

/** The sidebar's width, its bounds and the default. */
const SIDEBAR_WIDTH = 300;
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 520;

function clampWidth(width: unknown): number {
  const value = typeof width === "number" && Number.isFinite(width) ? width : SIDEBAR_WIDTH;
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, value)));
}

/** The sidebar's right edge: drag to widen or narrow it, double-click for the default. */
function SidebarResizer({ width, onResize }: { width: number; onResize: (width: number, done: boolean) => void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      aria-label={t("Resize the sidebar")}
      aria-orientation="vertical"
      aria-valuemax={SIDEBAR_MAX}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuenow={width}
      className={`sidebar-resizer ${dragging ? "dragging" : ""}`}
      onDoubleClick={() => onResize(SIDEBAR_WIDTH, true)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          onResize(width + (event.key === "ArrowRight" ? 16 : -16), true);
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        const start = event.clientX;
        const from = width;
        let last = from;
        setDragging(true);
        document.body.classList.add("resizing-sidebar");
        const move = (next: PointerEvent) => {
          last = from + next.clientX - start;
          onResize(last, false);
        };
        const up = () => {
          setDragging(false);
          document.body.classList.remove("resizing-sidebar");
          onResize(last, true);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      role="separator"
      tabIndex={0}
      title={t("Drag to resize, double-click to reset")}
    />
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
  // Sessions whose nested forks are folded away. Open by default: a fork is
  // something you made and came back for. Remembered on this machine.
  const [closedForks, setClosedForks] = useState<Record<string, boolean>>(() => remembered("thingmaker.sidebar.closedForks", {}));
  const toggleForks = (id: string) => {
    const next = { ...closedForks, [id]: !closedForks[id] };
    setClosedForks(next);
    remember("thingmaker.sidebar.closedForks", next);
  };
  // The sidebar's width, dragged from its right edge and remembered here.
  const [width, setWidth] = useState(() => clampWidth(remembered("thingmaker.sidebar.width", SIDEBAR_WIDTH)));
  const resize = (next: number, done: boolean) => {
    const clamped = clampWidth(next);
    setWidth(clamped);
    if (done) remember("thingmaker.sidebar.width", clamped);
  };
  // The scrollbar shows while the list scrolls, then fades away.
  const [scrolling, setScrolling] = useState(false);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const onScroll = () => {
    setScrolling(true);
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      setScrolling(false);
      // WebKit keeps painting a scrollbar thumb whose style changed while
      // nothing scrolls; a reflow of the scroller repaints it hidden.
      requestAnimationFrame(() => {
        const element = body.current;
        if (!element) return;
        const top = element.scrollTop;
        element.style.overflowY = "hidden";
        void element.offsetHeight;
        element.style.overflowY = "";
        element.scrollTop = top;
      });
    }, 900);
  };
  useEffect(() => () => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
  }, []);
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
    const forks = new Set(workspaceRecords.filter((r) => r.origin === "fork").map((r) => r.agentSessionId));

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
      fork: session.snapshot.agentSessionId !== null && forks.has(session.snapshot.agentSessionId),
    }));

    // Every session the desktop has opened is in its own records, whichever
    // provider ran it, so the records are the list. A live attachment is
    // listed once, as live; a session whose transcript the agent no longer
    // has is a tombstone and is left out.
    const liveAgentIds = new Set(live.map((session) => session.snapshot.agentSessionId).filter((id): id is string => !!id));
    const storedRows: Row[] = workspaceRecords
      // A side session is shown inside its main session, not in the list.
      .filter((record) => !liveAgentIds.has(record.agentSessionId) && record.archiveState !== "unavailable" && record.origin !== "side")
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
        fork: forks.has(record.agentSessionId),
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
    <nav aria-label={t("Workspaces and sessions")} className="sidebar" style={IS_REMOTE ? undefined : { width }}>
      {!IS_REMOTE && <SidebarResizer onResize={resize} width={width} />}
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

      <div className={`sidebar-body ${scrolling ? "scrolling" : ""}`} onScroll={onScroll} ref={body}>
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
                  {(() => {
                    // Who is shown: a row under a listed parent shows while
                    // that parent shows and has it open — a fork while its
                    // nested sessions are open (the default), a worker while
                    // the team is open and, once finished, when asked for.
                    const byId = new Map(unpinned.filter((row) => row.id).map((row) => [row.id as string, row]));
                    const depthOf = new Map<Row, number>();
                    const shown = new Set<Row>();
                    for (const row of unpinned) {
                      const parent = row.parent ? byId.get(row.parent) : undefined;
                      if (!parent) {
                        depthOf.set(row, 0);
                        shown.add(row);
                        continue;
                      }
                      depthOf.set(row, (depthOf.get(parent) ?? 0) + 1);
                      const open = row.fork ? !closedForks[row.parent as string] : !!openTeams[row.parent as string] && (row.running || !!openFinished[row.parent as string]);
                      if (shown.has(parent) && open) shown.add(row);
                    }
                    return unpinned.map((row) => {
                      if (!shown.has(row)) return null;
                      const children = row.id ? unpinned.filter((child) => child.parent === row.id) : [];
                      const workers = children.filter((child) => !child.fork);
                      const nested = children.filter((child) => child.fork);
                      const running = workers.filter((child) => child.running).length;
                      const finished = workers.length - running;
                      const depth = depthOf.get(row) ?? 0;
                      return (
                        <SessionGroup key={row.liveId ?? row.id}>
                          <SessionRow
                            depth={depth}
                            onMenu={(target, at) => setMenu({ row: target, at })}
                            onRename={(title) => {
                              setRenaming(null);
                              if (title !== null && row.id) void renameSession(row.workspaceId, row.id, title);
                            }}
                            renaming={renaming === row.id}
                            row={row}
                          />
                          {nested.length > 0 && row.id && (
                            <li className="session-li session-nested" style={{ marginLeft: 14 * (depth + 1) }}>
                              <button aria-expanded={!closedForks[row.id]} className="disclosure small" onClick={() => toggleForks(row.id as string)} type="button">
                                <IconChevron open={!closedForks[row.id]} size={12} />{" "}
                                {nested.length === 1 ? t("1 nested session") : t("{count} nested sessions", { count: nested.length })}
                              </button>
                            </li>
                          )}
                          {workers.length > 0 && row.id && (
                            <li className="session-li session-worker" style={{ marginLeft: 14 * (depth + 1) }}>
                              <button className="disclosure small" onClick={() => toggleTeam(row.id as string)} type="button">
                                <IconChevron open={!!openTeams[row.id]} size={12} /> {workers.length === 1 ? t("1 worker") : t("{count} workers", { count: workers.length })}
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
                    });
                  })()}
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

      {menu && (
        <RowMenu
          at={menu.at}
          onClose={() => setMenu(null)}
          onRename={() => setRenaming(menu.row.id)}
          parentLabel={(menu.row.parent && groups.flatMap((group) => [...group.unpinned, ...group.pinnedRows, ...group.archivedRows]).find((row) => row.id === menu.row.parent)?.label) || null}
          row={menu.row}
        />
      )}

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
        {PROVIDERS.some((provider) => usage[provider]?.primary) && <div className="sidebar-meters small muted">
          {PROVIDERS.map((provider) => {
            const snapshot = usage[provider];
            if (!snapshot?.primary) return null;
            const title = t("{provider}, account-wide. Details in a session's Context tab.", { provider: `${PROVIDER_LABELS[provider]}${snapshot.planType ? ` (${snapshot.planType})` : ""}` });
            return (
              <div className="sidebar-meter-row" key={provider} title={snapshot.limitReached ? `${title} · ${t("limit reached")}` : title}>
                <span className={`sidebar-meter-name ${snapshot.limitReached ? "chip-warn-text" : ""}`}>{PROVIDER_LABELS[provider]}</span>
                <UsageMeter usage={snapshot.primary} />
                {snapshot.secondary ? <UsageMeter usage={snapshot.secondary} /> : <span />}
              </div>
            );
          })}
        </div>}
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
            title={t("Teams: an orchestrator and its workers")}
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
