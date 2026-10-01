/**
 * The "Add or change work" dialog. Its whole reason to exist is that it can be
 * used while a turn is running, so these assert that it queues and never
 * submits, and that a folder becomes a reference rather than an attachment.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AmendmentRecord } from "@thingmaker/contracts";

type DropPayload = { type: "enter" | "over" | "leave" | "drop"; paths?: string[] };
type DropHandler = (event: { payload: DropPayload }) => void;

vi.mock("@tauri-apps/api/core", () => {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  return {
    invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "odyssey_inspect_refs") {
        const paths = ((args.request as { paths: string[] }).paths ?? []).filter((path) => !path.startsWith("/outside"));
        if (paths.length === 0) throw { code: "UNSUPPORTED", message: "outside this workspace", retry: "user_action" };
        return paths.map((path) => ({ path: path.replace(/^\/work\//, ""), kind: "directory", detail: "48 files" }));
      }
      if (command === "odyssey_amend_add") return {};
      if (command === "odyssey_amend_list") return [];
      if (command === "odyssey_journal_append") return {};
      if (command === "odyssey_read_plan") return "# Ships\nOne per class.";
      if (command === "odyssey_view") return null;
      throw new Error(`unexpected command ${command}`);
    }),
    Channel: class {
      onmessage: ((event: unknown) => void) | null = null;
    },
    __calls: calls,
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/webview", () => {
  const handlers: DropHandler[] = [];
  return {
    getCurrentWebview: () => ({
      onDragDropEvent: async (handler: DropHandler) => {
        handlers.push(handler);
        return () => undefined;
      },
    }),
    __handlers: handlers,
  };
});

import * as core from "@tauri-apps/api/core";
import * as webview from "@tauri-apps/api/webview";
import { useStore } from "./store";
import { AmendDialog, AmendmentList } from "./components/OdysseyAmend";

const calls = (core as unknown as { __calls: { command: string; args: Record<string, unknown> }[] }).__calls;
const handlers = (webview as unknown as { __handlers: DropHandler[] }).__handlers;
const commands = () => calls.map((entry) => entry.command);

function dialog() {
  return render(<AmendDialog odysseyId="o1" onClose={() => undefined} sessionId="sess-1" workspaceId="w1" />);
}

async function drop(paths: string[]) {
  await waitFor(() => expect(handlers.length).toBeGreaterThan(0));
  await act(async () => {
    for (const handler of handlers) handler({ payload: { type: "drop", paths } });
  });
}

beforeEach(() => {
  calls.length = 0;
  handlers.length = 0;
  useStore.setState({ odyssey: { "sess-1": { goal: { id: "o1", state: "running" }, milestones: [], journal: [] } } as never, odysseyAmendments: {}, error: null });
});
afterEach(cleanup);

describe("asking for a change mid-run", () => {
  it("says plainly that it will not interrupt the run", () => {
    dialog();
    expect(screen.getByText(/does not interrupt the run/)).toBeTruthy();
    expect(screen.getByText(/the agent decides where it belongs/)).toBeTruthy();
  });

  it("will not queue an empty request", () => {
    dialog();
    expect((screen.getByRole("button", { name: "Queue for the agent" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("queues the note without submitting anything to the session", async () => {
    dialog();
    fireEvent.change(screen.getByLabelText("What you want"), { target: { value: "Generate the ships and embed them" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Queue for the agent" }));
    });

    // Handed to the engine, which queues it and carries it on the next prompt.
    const queued = calls.find((entry) => entry.command === "superthing_amend");
    expect((queued?.args.request as Record<string, unknown>).note).toBe("Generate the ships and embed them");
    // The point of the whole feature: no prompt goes out from here.
    expect(commands()).not.toContain("session_submit");
  });

  it("turns a dropped project folder into a reference the agent opens itself", async () => {
    dialog();
    await drop(["/work/Assets/Art/Ships"]);

    expect(screen.getByText("Assets/Art/Ships")).toBeTruthy();
    expect(screen.getByText("48 files")).toBeTruthy();
    // Referenced, not read: nothing about its contents is in the request.
    expect(commands()).not.toContain("odyssey_read_plan");
  });

  it("reads a document from outside the workspace, since the agent cannot", async () => {
    dialog();
    await drop(["/outside/ships.md"]);

    expect(screen.getByText("ships.md")).toBeTruthy();
    expect(screen.getByText(/quoted in the prompt/)).toBeTruthy();
  });

  it("refuses a non-document from outside the workspace rather than pretending", async () => {
    dialog();
    await drop(["/outside/ships.blend"]);

    await waitFor(() => expect(useStore.getState().error?.message).toContain("no way to read it"));
    expect(screen.queryByText("ships.blend")).toBeNull();
  });

  it("takes a typed path too, and lets a reference be removed", async () => {
    dialog();
    fireEvent.change(screen.getByLabelText(/Point the agent at files or folders/), { target: { value: "Assets/Art/Ships" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(screen.getByText("Assets/Art/Ships")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove Assets/Art/Ships" }));
    expect(screen.queryByText("Assets/Art/Ships")).toBeNull();
  });
});

function record(overrides: Partial<AmendmentRecord> = {}): AmendmentRecord {
  return { id: "a1", odysseyId: "o1", at: 1, note: "Generate the ships", refs: [], state: "pending", tellCount: 0, ...overrides };
}

describe("the list of what you asked for", () => {
  it("says how far each request has got", () => {
    render(<AmendmentList amendments={[record(), record({ id: "a2", note: "Add sound", state: "told" })]} sessionId="sess-1" />);
    expect(screen.getByText("queued for the next prompt")).toBeTruthy();
    expect(screen.getByText("with the agent")).toBeTruthy();
    expect(screen.getByText("2 waiting")).toBeTruthy();
  });

  it("only offers to discard one the agent has not been told about", () => {
    render(<AmendmentList amendments={[record(), record({ id: "a2", state: "told" })]} sessionId="sess-1" />);
    expect(screen.getAllByRole("button", { name: "discard" })).toHaveLength(1);
  });

  it("disappears once everything has been folded in", () => {
    const { container } = render(<AmendmentList amendments={[record({ state: "applied" }), record({ id: "a2", state: "discarded" })]} sessionId="sess-1" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the references so it is clear what the agent was pointed at", () => {
    render(<AmendmentList amendments={[record({ refs: [{ path: "Assets/Art/Ships", kind: "directory", detail: "48 files" }] })]} sessionId="sess-1" />);
    expect(within(screen.getByRole("listitem")).getByText("Assets/Art/Ships")).toBeTruthy();
  });
});
