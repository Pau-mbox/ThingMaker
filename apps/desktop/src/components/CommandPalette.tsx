/**
 * Command palette (UX-11, B22): every primary action reachable by keyboard.
 * Opened with ⌘/Ctrl+K. Arrow keys move, Enter runs, Escape closes and
 * restores focus to the element that had it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { SESSION_TABS, basenameOf, sessionTitle, useStore } from "../store";

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
      { id: "workspace.add", label: "Add workspace…", hint: "⌘O", run: () => void state.addWorkspaceByPicker() },
      { id: "view.signin", label: "Provider sign-in", hint: "⌘,", run: () => { state.setView({ kind: "signin" }); void state.loadProviders(); } },
      { id: "view.settings", label: "Settings", hint: "⌘;", run: () => { state.setView({ kind: "settings" }); void state.loadSettings(); } },
      { id: "view.teams", label: "Teams (orchestrator and worker presets)", run: () => state.setView({ kind: "teams" }) },
      { id: "view.integrations", label: "Integration configuration (MCP, plugins, skills, harnesses)", hint: "⌘I", run: () => state.setView({ kind: "integrations" }) },
      { id: "view.welcome", label: "Welcome", run: () => state.setView({ kind: "welcome" }) },
    ];
    for (const workspace of state.workspaces) {
      list.push({ id: `ws.${workspace.id}`, label: `Open workspace ${basenameOf(workspace.displayPath)}`, hint: workspace.displayPath, run: () => void state.selectWorkspace(workspace.id) });
      const inspection = state.inspections[workspace.id];
      if (inspection?.record.trustState === "trusted_local" && !inspection.trustStale) {
        list.push({ id: `ws.new.${workspace.id}`, label: `New session in ${basenameOf(workspace.displayPath)}`, hint: "⌘N when selected", run: () => void state.openSession(workspace.id, { mode: "new" }) });
      }
    }
    state.sessionOrder.forEach((id, position) => {
      const session = state.sessions[id];
      if (!session) return;
      list.push({ id: `session.${id}`, label: `Switch to session ${sessionTitle(session)}`, hint: position < 9 ? `⌘${position + 1}` : undefined, run: () => state.selectSession(id) });
    });
    if (state.view.kind === "session") {
      const id = state.view.sessionId;
      const session = state.sessions[id];
      if (session) {
        list.push({ id: "session.focus", label: "Focus composer", hint: "⌘L", run: () => state.focusComposer() });
        list.push({ id: "session.cancel", label: "Cancel current turn", run: () => void state.cancel(id) });
        list.push({ id: "session.stop", label: "Stop session (asks first when work is live)", run: () => void state.stop(id) });
        list.push({ id: "session.refresh", label: "Refresh from snapshot", run: () => void state.refreshSnapshot(id) });
        list.push({ id: "session.search", label: "Search transcript", hint: "⌘F", run: () => state.setTranscriptSearchOpen(true) });
        list.push({ id: "session.export", label: "Export transcript as Markdown…", run: () => void state.exportTranscript(id) });
        for (const tab of SESSION_TABS) {
          list.push({ id: `tab.${tab}`, label: `Show ${tab} tab`, run: () => state.setSessionTab(tab) });
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
    action.run();
  };
  return (
    <div aria-modal="true" className="modal-backdrop palette-backdrop" onClick={() => setOpen(false)} role="dialog">
      <div aria-label="Command palette" className="palette" onClick={(e) => e.stopPropagation()} role="document">
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
              setOpen(false);
            }
          }}
          placeholder="Type a command…"
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          value={query}
        />
        <ul className="palette-list" id="palette-list" role="listbox">
          {filtered.length === 0 && <li className="muted small palette-item">No matching commands</li>}
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
