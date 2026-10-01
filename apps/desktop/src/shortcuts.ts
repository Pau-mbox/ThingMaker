/**
 * Keyboard commands (UX-11). All primary actions stay reachable by keyboard:
 * ⌘/Ctrl+O add workspace, ⌘/Ctrl+N new session in the selected workspace,
 * ⌘/Ctrl+1..9 switch sessions, ⌘/Ctrl+L focus the composer, ⌘/Ctrl+, sign-in,
 * ⌘/Ctrl+; settings, ⌘/Ctrl+K command palette, ⌘/Ctrl+I integrations,
 * ⌘/Ctrl+F transcript search, ⌘/Ctrl+B toggle sidebar.
 * Enter / Shift+Enter inside the composer are handled by the composer itself.
 */
import { useEffect } from "react";
import { useStore } from "./store";

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const state = useStore.getState();
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        state.setPaletteOpen(!state.paletteOpen);
        return;
      }
      if (key === "b") {
        event.preventDefault();
        state.toggleSidebar();
        return;
      }
      if (key === "i") {
        event.preventDefault();
        state.setView({ kind: "integrations" });
        return;
      }
      if (key === "f" && state.view.kind === "session") {
        event.preventDefault();
        state.setTranscriptSearchOpen(true);
        return;
      }
      if (key === "o") {
        event.preventDefault();
        void state.addWorkspaceByPicker();
        return;
      }
      if (key === "n") {
        const workspaceId =
          state.view.kind === "workspace"
            ? state.view.workspaceId
            : state.view.kind === "session"
              ? state.sessions[state.view.sessionId]?.workspaceId
              : undefined;
        const inspection = workspaceId ? state.inspections[workspaceId] : undefined;
        if (workspaceId && inspection?.record.trustState === "trusted_local" && !inspection.trustStale) {
          event.preventDefault();
          void state.openSession(workspaceId, { mode: "new" });
        }
        return;
      }
      if (key === "l") {
        if (state.view.kind === "session") {
          event.preventDefault();
          state.focusComposer();
        }
        return;
      }
      if (key === ",") {
        event.preventDefault();
        state.setView({ kind: "signin" });
        void state.loadProviders();
        return;
      }
      if (key === ";") {
        event.preventDefault();
        state.setView({ kind: "settings" });
        void state.loadSettings();
        return;
      }
      if (/^[1-9]$/.test(key)) {
        const id = state.sessionOrder[Number(key) - 1];
        if (id) {
          event.preventDefault();
          state.selectSession(id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
