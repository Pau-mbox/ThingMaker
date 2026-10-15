/**
 * Markdown documents in the transcript: found from what the tools wrote and
 * what the agent named, placed once, shown with a preview and actions, and
 * handed to Big Thing in one click.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolPatch } from "@thingmaker/contracts";

const calls: { command: string; args: Record<string, unknown> }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "file_read") {
      if (args.relative === "gone.md") throw { code: "NOT_FOUND", message: "no such file" };
      const content = ["# Game", "", "## Pillars", ...Array.from({ length: 30 }, (_, index) => `- point ${index + 1}`)].join("\n");
      return { relativePath: args.relative, content, contentHash: "h", bytes: 2048, totalLines: 33, offsetLine: 0, returnedLines: 33, truncated: false, binary: false, editable: true, crlf: false, modifiedUnixMs: Date.now() };
    }
    return null;
  }),
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { useStore } from "./store";
import { docsNamedIn, docsWrittenBy } from "./markdownDocs";
import { DocCard } from "./components/DocCard";
import { groupCards, placeDocs } from "./components/SessionPanel";
import type { Card } from "./projection";

const ROOT = "/w/app";
const tool = (id: string, fields: Partial<ToolPatch>): ToolPatch => ({ toolCallId: id, title: null, status: "completed", toolKind: "edit", content: null, rawInput: null, rawOutput: null, name: null, locations: null, meta: null, present: [], cleared: [], ...fields });

beforeEach(() => {
  calls.length = 0;
  useStore.setState({ workspaces: [{ id: "w1", canonicalRoot: ROOT, displayPath: ROOT } as never], odyssey: {}, bigThingDoc: {}, sessionTab: "transcript" });
});
afterEach(cleanup);

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("finding the documents", () => {
  it("reads what a Claude write, a Codex patch and a shell call reported writing, inside the workspace only", () => {
    expect(docsWrittenBy(tool("a", { rawInput: { file_path: `${ROOT}/Docs/GAME.md` }, locations: [{ path: `${ROOT}/Docs/GAME.md` }] }), [ROOT])).toEqual(["Docs/GAME.md"]);
    expect(docsWrittenBy(tool("b", { rawInput: { changes: [{ path: `${ROOT}/a.md`, kind: "add" }, { path: `${ROOT}/b.ts`, kind: "update" }, { path: `${ROOT}/c.md`, kind: "delete" }] } }), [ROOT])).toEqual(["a.md"]);
    expect(docsWrittenBy(tool("c", { rawInput: { file_path: "/elsewhere/x.md" } }), [ROOT])).toEqual([]);
    expect(docsWrittenBy(tool("d", { toolKind: "read", title: "Read a.md", locations: [{ path: `${ROOT}/a.md` }] }), [ROOT])).toEqual([]);
  });

  it("reads the paths a message names, and nothing that is a web address", () => {
    const text = "I rewrote `Docs/GAME.md` and linked [the roadmap](./Docs/ROADMAP.md). See https://example.com/x.md and /w/app/NOTES.md.";
    expect(docsNamedIn(text, [ROOT])).toEqual(["Docs/GAME.md", "Docs/ROADMAP.md", "NOTES.md"]);
  });

  it("places each document once: under the last run that wrote it, else the last message naming it", () => {
    const tools = new Map<string, ToolPatch>([
      ["t1", tool("t1", { rawInput: { file_path: `${ROOT}/GAME.md` } })],
      ["t2", tool("t2", { rawInput: { file_path: `${ROOT}/GAME.md` } })],
    ]);
    const message = (key: string, text: string) => ({ kind: "message", key, message: { role: "agent", messageId: key, blocks: [{ type: "text", text }], contentUnknown: false } }) as unknown as Card;
    const groups = groupCards([
      { kind: "tool", key: "k1", toolCallId: "t1" },
      message("m1", "Wrote `GAME.md`."),
      { kind: "tool", key: "k2", toolCallId: "t2" },
      message("m2", "Updated `GAME.md`; also see `PLAN.md`."),
    ]);
    const placed = placeDocs(groups, tools, [ROOT]);
    expect([...placed.entries()].map(([index, docs]) => [index, docs.map((doc) => `${doc.verb}:${doc.path}`)])).toEqual([
      [2, ["wrote:GAME.md"]],
      [3, ["named:PLAN.md"]],
    ]);
  });
});

describe("a document card", () => {
  it("shows the top of the document, and opens the whole of it", async () => {
    render(<DocCard relative="Docs/GAME.md" sessionId="s1" verb="wrote" version="1" workspaceId="w1" />);
    await settle();
    expect(screen.getByText("GAME.md")).toBeTruthy();
    expect(screen.getByText(/written · 33 lines · 2.0 KB/)).toBeTruthy();
    expect(screen.getByText("Pillars")).toBeTruthy();
    expect(screen.queryByText("point 30")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("point 30")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open$/ }));
    await settle();
    expect(screen.getByRole("dialog", { name: "Docs/GAME.md" })).toBeTruthy();
  });

  it("shows it in Finder by its full path", async () => {
    render(<DocCard relative="Docs/GAME.md" sessionId="s1" verb="wrote" version="1" workspaceId="w1" />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Finder/ }));
    expect(calls.find((call) => call.command === "reveal_in_finder")?.args).toEqual({ path: `${ROOT}/Docs/GAME.md` });
  });

  it("sends the document to Big Thing and switches to its tab", async () => {
    render(<DocCard relative="Docs/GAME.md" sessionId="s1" verb="named" version="" workspaceId="w1" />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Big Thing/ }));
    expect(useStore.getState().bigThingDoc).toEqual({ s1: `${ROOT}/Docs/GAME.md` });
    expect(useStore.getState().sessionTab).toBe("odyssey");
    expect(useStore.getState().takeBigThingDoc("s1")).toBe(`${ROOT}/Docs/GAME.md`);
    expect(useStore.getState().takeBigThingDoc("s1")).toBeNull();
  });

  it("offers to add it to the goal when one is running", async () => {
    useStore.setState({ odyssey: { s1: { goal: {}, milestones: [], journal: [] } as never } });
    render(<DocCard relative="Docs/GAME.md" sessionId="s1" verb="named" version="" workspaceId="w1" />);
    await settle();
    expect(screen.getByRole("button", { name: /Add to Big Thing/ })).toBeTruthy();
  });

  it("is not shown for a named path that is not there", async () => {
    const { container } = render(<DocCard relative="gone.md" sessionId="s1" verb="named" version="" workspaceId="w1" />);
    await settle();
    expect(container.firstChild).toBeNull();
  });
});
