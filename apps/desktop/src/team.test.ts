/**
 * Teams in the renderer: what a new worker starts as, how jobs are kept in
 * order, where a worker is listed, and what a handoff to another provider
 * tells the new orchestrator.
 */
import { describe, expect, it } from "vitest";
import type { JobView, ProviderModel } from "@thingmaker/contracts";
import { nestWorkers } from "./components/Sidebar";
import type { Card } from "./projection";
import { handoffBrief, jobDuration, newPreset, presetMatches, presetWorker, readPresets, shortName, teamSummary, uniqueName, upsertJob, upsertPreset } from "./team";

const model = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({ id, name: id, needsCredits: false, efforts: ["low", "high"], inputImage: true, isDefault: false, ...extra });

describe("a new worker", () => {
  it("starts on Codex's fast model for images, Claude's Sonnet for code, and a mid Gemini Flash", () => {
    expect(presetWorker("gemini", [model("gemini-3.1-pro-high"), model("gemini-3.8-flash-medium"), model("gemini-3.8-flash-low")], [])).toMatchObject({
      name: "flash",
      provider: "gemini",
      model: "gemini-3.8-flash-medium",
      capabilities: ["fast", "research"],
    });
    const codex = presetWorker("codex", [model("gpt-6-astra", { isDefault: true }), model("gpt-6-luna")], []);
    expect(codex).toMatchObject({ name: "luna", provider: "codex", model: "gpt-6-luna", effort: "low", capabilities: ["image", "fast", "code"] });
    const claude = presetWorker("claude", [model("opus", { isDefault: true }), model("sonnet")], ["luna"]);
    expect(claude).toMatchObject({ name: "sonnet", model: "sonnet", capabilities: ["code", "review"] });
  });

  it("has a name nobody else on the team has, even before the catalog loads", () => {
    expect(presetWorker("codex", [model("gpt-6-luna")], ["Luna"]).name).toBe("luna-2");
    expect(presetWorker("claude", undefined, [])).toEqual({ name: "claude", provider: "claude", capabilities: ["code", "review"] });
    expect(uniqueName("a", ["a", "a-2"])).toBe("a-3");
    expect(shortName(model("claude-fable-5-1[1m]"))).toBe("fable");
    expect(shortName(model("gemini-3.8-flash-medium"))).toBe("flash");
    expect(shortName(model("gemini-3.1-pro-high"))).toBe("pro");
    expect(shortName(model("claude-opus-4-6-thinking"))).toBe("opus");
    expect(shortName(model("gpt-oss-120b-medium"))).toBe("oss");
    expect(shortName(model("opus"))).toBe("opus");
  });

  it("is summarised for the chip", () => {
    expect(teamSummary(undefined)).toContain("alone");
    expect(teamSummary({ workers: [{ name: "luna", provider: "codex", model: "gpt-6-luna", capabilities: [] }], nativeSubagents: false })).toBe("luna (Codex · gpt-6-luna)");
  });
});

const job = (id: string, startedAtUnixMs: number, extra: Partial<JobView> = {}): JobView => ({
  id,
  orchestrator: "cx-o",
  worker: "luna",
  provider: "codex",
  task: "draw",
  status: "running",
  toolCalls: 0,
  attempts: 0,
  startedAtUnixMs,
  ...extra,
});

describe("jobs", () => {
  it("are replaced by id and kept in start order", () => {
    let list = upsertJob(undefined, job("job-2", 20));
    list = upsertJob(list, job("job-1", 10));
    list = upsertJob(list, job("job-2", 20, { status: "succeeded", result: "done" }));
    expect(list.map((entry) => [entry.id, entry.status])).toEqual([
      ["job-1", "running"],
      ["job-2", "succeeded"],
    ]);
  });

  it("say how long they ran, or have been running", () => {
    expect(jobDuration(job("a", 0, { finishedAtUnixMs: 42_000 }), 99_999_999)).toBe("42 s");
    expect(jobDuration(job("a", 0), 125_000)).toBe("2 min 5 s");
    expect(jobDuration(job("a", 0), 3_900_000)).toBe("1 h 5 min");
  });
});

describe("the sidebar", () => {
  it("lists a worker under the session it works for", () => {
    const rows = [
      { id: "w1", parent: "o1" },
      { id: "o2", parent: null },
      { id: "o1", parent: null },
      { id: "orphan", parent: "gone" },
    ];
    expect(nestWorkers(rows).map((row) => row.id)).toEqual(["o2", "o1", "w1", "orphan"]);
  });
});

const message = (role: "user" | "agent" | "thought", text: string, key: string): Card => ({
  kind: "message",
  key,
  message: { key, role, messageId: key, blocks: [{ type: "text", text }], contentUnknown: false },
});

describe("a handoff to another provider", () => {
  it("tells the new orchestrator where it came from and what was said, newest kept first", () => {
    const cards: Card[] = [message("user", "Build the pricing page", "1"), message("thought", "hmm", "2"), { kind: "turn", key: "t", text: "turn succeeded" }, message("agent", "Done: pricing.tsx", "3")];
    const brief = handoffBrief(cards, "claude");
    expect(brief).toContain("from a Claude Code session");
    expect(brief).toContain("User: Build the pricing page\nAgent: Done: pricing.tsx");
    expect(brief).not.toContain("hmm");
    const long = handoffBrief([message("user", "x".repeat(500), "a"), message("agent", "y".repeat(500), "b")], "codex", 550);
    expect(long).toContain("(1 earlier messages left out.)");
    expect(long).toContain("Agent: yyyy");
    expect(handoffBrief([], "codex")).toContain("no conversation yet");
  });
});

describe("team presets", () => {
  it("get a unique name and sort by it", () => {
    const first = newPreset("Images", []);
    const second = newPreset("Images", ["Images"]);
    expect(second.name).toBe("Images-2");
    expect(first.id).not.toBe(second.id);
    const list = upsertPreset(upsertPreset([], { ...second, name: "Zeta" }), { ...first, name: "Alpha" });
    expect(list.map((preset) => preset.name)).toEqual(["Alpha", "Zeta"]);
    expect(upsertPreset(list, { ...first, name: "Beta" }).map((preset) => preset.name)).toEqual(["Beta", "Zeta"]);
  });

  it("are read back defensively and matched to a session by provider and workers", () => {
    const preset = { ...newPreset("Pair", []), combo: { workers: [{ name: "luna", provider: "codex" as const, capabilities: ["image"] }], nativeSubagents: false } };
    expect(readPresets([preset, { id: 1 }, null, "x"])).toEqual([preset]);
    expect(readPresets("nope")).toEqual([]);
    expect(presetMatches(preset, "claude", preset.combo)).toBe(true);
    expect(presetMatches({ ...preset, orchestrator: { provider: "claude", model: "opus" } }, "claude", preset.combo)).toBe(true);
    expect(presetMatches(preset, "codex", preset.combo)).toBe(false);
    expect(presetMatches(preset, "claude", { workers: [], nativeSubagents: false })).toBe(false);
  });
});
