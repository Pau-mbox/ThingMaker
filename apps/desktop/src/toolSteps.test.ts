/** Tool calls read as steps a person can follow, from what each provider reported. */
import { describe, expect, it } from "vitest";
import type { ToolPatch } from "@thingmaker/contracts";
import { mcpLabel, readShell, stepDoing, stepOf, stepText, summarize } from "./toolSteps";

const ROOT = "/Users/me/UnityProjects/P3";
const patch = (fields: Partial<ToolPatch>): ToolPatch => ({ toolCallId: "t", title: null, status: "completed", toolKind: "execute", content: null, rawInput: null, rawOutput: null, name: null, locations: null, meta: null, present: [], cleared: [], ...fields });
const shell = (command: string, extra: Partial<ToolPatch> = {}) => stepOf(patch({ title: command, rawInput: { command }, ...extra }), [ROOT]);

describe("a shell command as steps", () => {
  it("drops the cd into the project and names what each command did", () => {
    const step = shell(`cd ${ROOT}; ls Docs; grep -n -i "presentation\\|GUI\\|reskin" Docs/ROADMAP.md | head -20`);
    expect(stepText(step)).toBe("Listed Docs · searched Docs/ROADMAP.md for “presentation”, “GUI”, “reskin”");
  });

  it("reads a line range, relative to the folder it went into", () => {
    expect(stepText(shell(`cd ${ROOT}/Assets/Fleet; sed -n 147,200p CampaignRiskView.cs | cut -c1-220`))).toBe("Read CampaignRiskView.cs lines 147–200");
  });

  it("counts several reads and keeps the line short", () => {
    const step = shell(`cd ${ROOT}/Docs; cat MOBILE.md | cut -c1-400; head -30 Mockups/README.md; ls Mockups/Minimal | head`);
    expect(stepText(step)).toBe("Read MOBILE.md · read Mockups/README.md first 30 lines · +1 more");
    expect(summarize([step]).detail).toBe("read 2 files, listed 1 folder");
  });

  it("unwraps a login shell and calls anything else a run", () => {
    expect(readShell("/bin/zsh -lc 'pnpm test --filter app'", [ROOT])).toEqual([{ verb: "run", target: "pnpm test --filter", extra: null, files: 0 }]);
  });

  it("uses Codex's own reading of the command when it sent one", () => {
    const step = shell("weird | pipeline", { rawInput: { command: "x", actions: [{ type: "search", query: "tooltip", path: `${ROOT}/Assets` }, { type: "read", path: `${ROOT}/a.cs`, name: "a.cs" }] } });
    expect(stepText(step)).toBe("Searched Assets for “tooltip” · read a.cs");
  });

  it("prefers Claude's description of the command", () => {
    const step = shell("ls -la", { rawInput: { command: "ls -la", description: "List files in current directory" } });
    expect(stepText(step)).toBe("List files in current directory");
    expect(step.verb).toBe("list");
  });

  it("is failed when the command exited non-zero", () => {
    expect(shell("pnpm test", { rawOutput: { exitCode: 1 } }).failed).toBe(true);
    expect(shell("pnpm test", { status: "in_progress" }).running).toBe(true);
  });
});

describe("other tools", () => {
  it("keeps the adapter's title, with the project's prefix gone", () => {
    expect(stepText(stepOf(patch({ toolKind: "read", title: `Read ${ROOT}/Docs/GAME.md (1 - 40)` }), [ROOT]))).toBe("Read Docs/GAME.md (1 - 40)");
  });

  it("sums a run into a title and counts", () => {
    const steps = [
      stepOf(patch({ toolKind: "read", title: "Read a.md" }), [ROOT]),
      stepOf(patch({ toolKind: "search", title: "grep foo" }), [ROOT]),
      stepOf(patch({ toolKind: "read", title: "Read b.md" }), [ROOT]),
    ];
    expect(summarize(steps)).toEqual({ title: "Explored", detail: "read 2 files, searched 1 time" });
    expect(summarize([stepOf(patch({ toolKind: "edit", title: "Edit 2 files", locations: [{ path: "a" }, { path: "b" }] }), [ROOT])])).toEqual({ title: "Edited 2 files", detail: "" });
    expect(summarize([...steps, shell("pnpm test")]).title).toBe("Worked");
  });

  it("names MCP tools in words, ThingMaker's own team tools most plainly", () => {
    expect(mcpLabel("mcp__team__phone_install")).toBe("Installed an app on the phone");
    expect(mcpLabel("team · delegate")).toBe("Delegated a task");
    expect(mcpLabel("mcp__playwright__browser_navigate")).toBe("browser navigate · playwright");
    expect(mcpLabel("Read a.md")).toBeNull();
    expect(stepText(stepOf(patch({ toolKind: "other", title: "mcp__team__phone_install" }), [ROOT]))).toBe("Installed an app on the phone");
  });

  it("says what is happening now", () => {
    expect(stepDoing(shell(`sed -n 1,9p ${ROOT}/x.cs`))).toBe("reading x.cs");
  });
});
