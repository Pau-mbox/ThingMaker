/**
 * Back and forward through the places the user has been, like a browser:
 * each place is a view plus, inside a session, the panel it showed. The store
 * records every move after the fact, so no caller has to remember to.
 */
import type { SessionTab, View } from "./store";

export type NavEntry = { view: View; tab: SessionTab | null };

/** How many places the history keeps; the oldest fall off first. */
export const NAV_LIMIT = 50;

export function navEntry(view: View, tab: SessionTab): NavEntry {
  return { view, tab: view.kind === "session" ? tab : null };
}

function viewKey(view: View): string {
  if (view.kind === "session") return `session:${view.sessionId}`;
  if (view.kind === "workspace") return `workspace:${view.workspaceId}`;
  return view.kind;
}

export function sameEntry(a: NavEntry, b: NavEntry): boolean {
  return viewKey(a.view) === viewKey(b.view) && a.tab === b.tab;
}

/** The history after visiting `entry`: anything ahead of the current place is
 *  dropped, as in a browser. Null when `entry` is where the user already is. */
export function recordVisit(history: NavEntry[], index: number, entry: NavEntry): { history: NavEntry[]; index: number } | null {
  const current = history[index];
  if (current && sameEntry(current, entry)) return null;
  const next = [...history.slice(0, index + 1), entry].slice(-NAV_LIMIT);
  return { history: next, index: next.length - 1 };
}

/** The nearest place in `direction` that still exists and is not the current
 *  one: a closed session or a removed workspace is stepped over, not shown. */
export function navTarget(
  history: NavEntry[],
  index: number,
  direction: -1 | 1,
  exists: (view: View) => boolean,
): number | null {
  const current = history[index];
  for (let i = index + direction; i >= 0 && i < history.length; i += direction) {
    const entry = history[i]!;
    if (!exists(entry.view)) continue;
    if (current && sameEntry(current, entry)) continue;
    return i;
  }
  return null;
}
