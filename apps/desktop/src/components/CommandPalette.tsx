/**
 * Command palette (UX-11, B22): every primary action reachable by keyboard.
 * Opened with ⌘/Ctrl+K. Arrow keys move, Enter runs, Escape closes and
 * restores focus to the element that had it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { SESSION_TABS, basenameOf, sessionTitle, useStore, type SessionTab } from "../store";
import { t } from "../i18n";

/** A session tab by the name its button shows. */
function tabName(tab: SessionTab): string {
  switch (tab) {
    case "transcript": return t("Conversation");
    case "agents": return t("Agents");
    case "odyssey": return t("Big Thing board");
    case "terminal": return t("Terminal");
    case "files": return t("Files");
    case "changes": return t("Changes");
    case "context": return t("Context");
    case "artifacts": return t("Artifacts");
    case "images": return t("Images");
    default: return tab;
  }
}

type Action = { id: string; label: string; hint?: string | undefined; run: () => void };

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const state = useStore();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      restoreRef.current?.focus?.();
    }
  }, [open]);

  const actions = useMemo<Action[]>(() => {
    const list: Action[] = [
      { id: "view.chill", label: state.chillMode ? t("Leave Chill mode") : t("Enter Chill mode"), hint: "⌘⇧C", run: () => state.setChillMode(!state.chillMode) },
      { id: "workspace.add", label: t("Add workspace…"), hint: "⌘O", run: () => void state.addWorkspaceByPicker() },
      { id: "view.signin", label: t("Provider sign-in"), hint: "⌘,", run: () => { state.setView({ kind: "signin" }); void state.loadProviders(); } },
      { id: "view.settings", label: t("Settings"), hint: "⌘;", run: () => { state.setView({ kind: "settings" }); void state.loadSettings(); } },
      { id: "view.teams", label: t("Teams (an orchestrator and its workers)"), run: () => state.setView({ kind: "teams" }) },
      { id: "view.integrations", label: t("Integration configuration (MCP, plugins, skills, harnesses)"), hint: "⌘I", run: () => state.setView({ kind: "integrations" }) },
      { id: "view.welcome", label: t("Welcome"), run: () => state.setView({ kind: "welcome" }) },
    ];
    for (const workspace of state.workspaces) {
      list.push({ id: `ws.${workspace.id}`, label: t("Open workspace {name}", { name: basenameOf(workspace.displayPath) }), hint: workspace.displayPath, run: () => void state.selectWorkspace(workspace.id) });
      const inspection = state.inspections[workspace.id];
      if (inspection?.record.trustState === "trusted_local" && !inspection.trustStale) {
        list.push({ id: `ws.new.${workspace.id}`, label: t("New session in {name}", { name: basenameOf(workspace.displayPath) }), hint: t("⌘N when selected"), run: () => void state.openSession(workspace.id, { mode: "new" }) });
      }
    }
    state.sessionOrder.forEach((id, position) => {
      const session = state.sessions[id];
      if (!session) return;
      list.push({ id: `session.${id}`, label: t("Switch to session {title}", { title: sessionTitle(session) }), hint: position < 9 ? `⌘${position + 1}` : undefined, run: () => state.selectSession(id) });
    });
    if (state.view.kind === "session") {
      const id = state.view.sessionId;
      const session = state.sessions[id];
      if (session) {
        list.push({ id: "session.focus", label: t("Focus composer"), hint: "⌘L", run: () => state.focusComposer() });
        list.push({ id: "session.cancel", label: t("Cancel current turn"), run: () => void state.cancel(id) });
        list.push({ id: "session.stop", label: t("Stop session (asks first when work is live)"), run: () => void state.stop(id) });
        list.push({ id: "session.refresh", label: t("Refresh from snapshot"), run: () => void state.refreshSnapshot(id) });
        list.push({ id: "session.search", label: t("Search transcript"), hint: "⌘F", run: () => state.setTranscriptSearchOpen(true) });
        list.push({ id: "session.export", label: t("Export transcript as Markdown…"), run: () => void state.exportTranscript(id) });
        for (const tab of SESSION_TABS) {
          list.push({ id: `tab.${tab}`, label: t("Show the {tab} tab", { tab: tabName(tab) }), run: () => state.setSessionTab(tab) });
        }
      }
    }
    return list;
  }, [state]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(q) || (a.hint ?? "").toLowerCase().includes(q));
  }, [actions, query]);

  if (!open) return null;
  const run = (action: Action | undefined) => {
    if (!action) return;
    setOpen(false);
    if(action.id!=="view.chill")state.setChillMode(false);
    action.run();
  };
  return (
    <div aria-modal="true" className="modal-backdrop palette-backdrop" onClick={() => setOpen(false)} role="dialog">
      <div aria-label={t("Command palette")} className="palette" onClick={(e) => e.stopPropagation()} role="document">
        <input
          aria-activedescendant={filtered[index] ? `palette-${filtered[index].id}` : undefined}
          aria-autocomplete="list"
          aria-controls="palette-list"
          className="input palette-input"
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(filtered.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(filtered[index]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
          placeholder={t("Type a command…")}
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          value={query}
        />
        <ul className="palette-list" id="palette-list" role="listbox">
          {filtered.length === 0 && <li className="muted small palette-item">{t("No matching commands")}</li>}
          {filtered.slice(0, 40).map((action, i) => (
            <li
              aria-selected={i === index}
              className={`palette-item ${i === index ? "palette-item-on" : ""}`}
              id={`palette-${action.id}`}
              key={action.id}
              onClick={() => run(action)}
              onMouseEnter={() => setIndex(i)}
              role="option"
            >
              <span>{action.label}</span>
              {action.hint && <span className="small muted">{action.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
