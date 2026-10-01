/**
 * The session bar's trailing controls.
 *
 * Five workspace views behind one menu is only an improvement if the bar
 * still says where you are and the menu is operable, so that is what these
 * assert: the trigger names the open view, the open one is marked, and
 * picking one switches to it.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("invoke is not available in tests");
  }),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }) }));

import { GROUPED_VIEWS, ViewsMenu } from "./components/SessionPanel";
import { SESSION_TABS, type SessionTab } from "./store";

afterEach(cleanup);

const open = () => fireEvent.click(screen.getByRole("button", { expanded: false }));

describe("the views menu", () => {
  it("groups exactly the views you open deliberately", () => {
    expect(GROUPED_VIEWS.map((view) => view.id)).toEqual(["files", "changes", "context", "artifacts", "images"]);
  });

  it("leaves every view reachable: the palette lists them all", () => {
    // The bar hides five views behind a menu and one behind an icon, so the
    // palette is the keyboard route and must not miss any of them.
    for (const view of GROUPED_VIEWS) expect(SESSION_TABS).toContain(view.id);
    for (const tab of ["transcript", "odyssey", "terminal"] as SessionTab[]) expect(SESSION_TABS).toContain(tab);
    expect(new Set(SESSION_TABS).size).toBe(SESSION_TABS.length);
  });

  it("says Views while none of them is open", () => {
    render(<ViewsMenu onPick={() => undefined} tab="transcript" />);
    expect(screen.getByRole("button", { name: /Views/ })).toBeTruthy();
  });

  it("names the open view, so the bar still says where you are", () => {
    render(<ViewsMenu onPick={() => undefined} tab="artifacts" />);
    expect(screen.getByRole("button", { name: /Artifacts/ })).toBeTruthy();
  });

  it("lists every view and marks the open one", () => {
    render(<ViewsMenu onPick={() => undefined} tab="changes" />);
    open();

    const menu = within(screen.getByRole("menu"));
    expect(menu.getAllByRole("menuitemradio")).toHaveLength(5);
    expect(menu.getByRole("menuitemradio", { name: /Changes/, checked: true })).toBeTruthy();
    expect(menu.getByRole("menuitemradio", { name: /Files/, checked: false })).toBeTruthy();
  });

  it("switches to the view that was picked, and closes", () => {
    const picked: SessionTab[] = [];
    render(<ViewsMenu onPick={(tab) => picked.push(tab)} tab="transcript" />);
    open();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Images/ }));

    expect(picked).toEqual(["images"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape without switching anything", () => {
    const picked: SessionTab[] = [];
    render(<ViewsMenu onPick={(tab) => picked.push(tab)} tab="transcript" />);
    open();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(picked).toEqual([]);
  });

  it("closes on a click elsewhere", () => {
    render(<ViewsMenu onPick={() => undefined} tab="transcript" />);
    open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("carries a live count out of the closed menu", () => {
    // A count on a grouped view has to survive on the trigger, or it is
    // hidden exactly when it matters.
    render(<ViewsMenu badges={{ artifacts: "2" }} onPick={() => undefined} tab="transcript" />);
    const trigger = screen.getByRole("button", { expanded: false });
    expect(trigger.textContent).toContain("Views");
    expect(within(trigger).getByText("2")).toBeTruthy();
  });

  it("does not repeat the count on the trigger while that view is open", () => {
    render(<ViewsMenu badges={{ artifacts: "2" }} onPick={() => undefined} tab="artifacts" />);
    const trigger = screen.getByRole("button", { expanded: false });
    expect(trigger.textContent).toBe("Artifacts");
    // It is still on the row inside, where it labels what it counts.
    fireEvent.click(trigger);
    expect(within(screen.getByRole("menuitemradio", { name: /Artifacts/ })).getByText("2")).toBeTruthy();
  });
});
