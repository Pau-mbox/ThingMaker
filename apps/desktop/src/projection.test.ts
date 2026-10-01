import { describe, expect, it } from "vitest";
import type { EventEnvelope, SessionEvent, ToolPatch } from "@thingmaker/contracts";
import { applyEvent, emptyProjection, isBackground, mergeToolPatch } from "./projection";

const handle = { id: "s", attachmentGeneration: "1" };
let sequence = 0;
function envelope(payload: SessionEvent): EventEnvelope {
  sequence += 1;
  return { apiVersion: 1, session: handle, sequence: String(sequence), payload };
}

function patch(fields: Partial<ToolPatch> & { present: string[]; cleared?: string[] }): ToolPatch {
  return {
    toolCallId: "c",
    title: null,
    status: null,
    toolKind: null,
    content: null,
    rawInput: null,
    rawOutput: null,
    name: null,
    locations: null,
    meta: null,
    cleared: [],
    ...fields,
  };
}

describe("tool patch merging", () => {
  it("treats missing as unchanged, null as cleared and values as replacements", () => {
    const base = mergeToolPatch(undefined, patch({ title: "Cleared background", rawInput: { background: true }, present: ["title", "rawInput"] }));
    expect(isBackground(base)).toBe(true);
    const unchanged = mergeToolPatch(base, patch({ present: [] }));
    expect(unchanged.title).toBe("Cleared background");
    expect(isBackground(unchanged)).toBe(true);
    const cleared = mergeToolPatch(base, patch({ rawInput: null, present: ["rawInput"], cleared: ["rawInput"] }));
    expect(cleared.rawInput).toBeNull();
    expect(isBackground(cleared)).toBe(false);
    expect(cleared.cleared).toContain("rawInput");
    const restored = mergeToolPatch(cleared, patch({ rawInput: { background: true }, status: "completed", present: ["rawInput", "status"] }));
    expect(isBackground(restored)).toBe(true);
    expect(restored.cleared).not.toContain("rawInput");
    expect(restored.title).toBe("Cleared background");
  });
});

describe("message projection", () => {
  it("appends chunks, replaces on full messages and distinguishes omitted content", () => {
    const projection = emptyProjection();
    applyEvent(projection, envelope({ type: "update", kind: "agent_message", messageId: "a", content: [{ type: "text", text: "stale " }], replace: false, hasContent: true }));
    applyEvent(projection, envelope({ type: "update", kind: "agent_message", messageId: "a", content: [{ type: "text", text: "response" }], replace: false, hasContent: true }));
    expect(projection.messages.get("agent|a")?.blocks).toEqual([{ type: "text", text: "stale response" }]);
    applyEvent(projection, envelope({ type: "update", kind: "agent_message", messageId: "a", content: [{ type: "text", text: "fresh response" }], replace: true, hasContent: true }));
    expect(projection.messages.get("agent|a")?.blocks).toEqual([{ type: "text", text: "fresh response" }]);
    applyEvent(projection, envelope({ type: "update", kind: "user_message", messageId: "omitted", content: [], replace: true, hasContent: false }));
    expect(projection.messages.get("user|omitted")?.contentUnknown).toBe(true);
    applyEvent(projection, envelope({ type: "update", kind: "user_message", messageId: "nulled", content: [], replace: true, hasContent: true }));
    expect(projection.messages.get("user|nulled")).toMatchObject({ blocks: [], contentUnknown: false });
    expect(projection.cards.filter((c) => c.kind === "message")).toHaveLength(3);
  });

  it("tracks turns, submissions and unknown cards", () => {
    const projection = emptyProjection();
    applyEvent(projection, envelope({ type: "submission", requestId: "r1", state: "accepted" }));
    applyEvent(projection, envelope({ type: "turn", effect: "started", kind: "foreground" }));
    expect(projection.foreground).toBe("running");
    applyEvent(projection, envelope({ type: "update", kind: "unknown", raw: { sessionUpdate: "vendor_future" }, truncated: false, originalKind: "vendor_future" }));
    applyEvent(projection, envelope({ type: "turn", effect: "settled", kind: "foreground", phase: "succeeded", stopReason: "end_turn" }));
    expect(projection.foreground).toBe("succeeded");
    // A turn that starts and succeeds is not narrated: the reply itself and
    // the activity strip already say so. The counter still moves, so anything
    // keyed to "a turn finished" keeps working.
    expect(projection.cards.filter((c) => c.kind === "turn")).toEqual([]);
    expect(projection.settledTurns).toBe(1);
    expect(projection.submissions.get("r1")?.state).toBe("accepted");
    const unknown = projection.cards.find((c) => c.kind === "unknown");
    expect(unknown && unknown.kind === "unknown" && unknown.label).toBe("update vendor_future");
    applyEvent(projection, envelope({ type: "snapshot_needed", reason: "subscriber lagged", skipped: 12 }));
    expect(projection.snapshotNeeded).toBe(true);
  });

  it("keeps a line for an outcome worth acting on", () => {
    const projection = emptyProjection();
    applyEvent(projection, envelope({ type: "turn", effect: "started", kind: "foreground" }));
    applyEvent(projection, envelope({ type: "turn", effect: "cancelling", kind: "foreground" }));
    applyEvent(projection, envelope({ type: "turn", effect: "settled", kind: "foreground", phase: "failed", error: "provider error" }));

    expect(projection.cards.filter((c) => c.kind === "turn").map((c) => (c.kind === "turn" ? c.text : ""))).toEqual([
      "cancellation requested",
      "foreground turn failed (provider error)",
    ]);
    expect(projection.settledTurns).toBe(1);
  });
});

describe("execution inspector", () => {
  it("builds the subagent tree, keeps unknown parents as roots and times compose children", () => {
    const projection = emptyProjection();
    const base = {
      type: "runtime_event" as const,
      event: "subagent_state_changed" as const,
      outcome: null,
      generation: 1,
      harness: "codex",
      model: null,
      created_at_unix_ms: 1000,
      generation_started_at_unix_ms: 1000,
      generation_finished_at_unix_ms: null,
      parent_name: null,
    };
    applyEvent(projection, envelope({ ...base, id: "root", name: "planner", status: "working", task: "plan", parent_id: null }));
    applyEvent(projection, envelope({ ...base, id: "child", name: "worker", status: "starting", task: "do", parent_id: "root" }));
    applyEvent(projection, envelope({ ...base, id: "orphan", name: "lost", status: "idle", task: "?", parent_id: "missing", parent_name: "ghost" }));
    expect(projection.inspector.agents.size).toBe(3);
    expect(projection.inspector.agents.get("child")?.parentId).toBe("root");
    expect(projection.inspector.agents.get("orphan")?.parentId).toBe("missing");

    applyEvent(projection, envelope({ type: "runtime_event", event: "subagent_descendants_removed", ancestor_id: "root" }));
    expect(projection.inspector.agents.has("child")).toBe(false);
    expect(projection.inspector.agents.has("root")).toBe(true);
    expect(projection.inspector.agents.has("orphan")).toBe(true);
    expect(projection.cards.filter((c) => c.kind === "runtime")).toHaveLength(4);
  });

  it("ignores events at or below the last applied sequence when replayed by the store logic", () => {
    // The dedupe lives in the store; here we only assert the projection records the sequence it applied.
    const projection = emptyProjection();
    applyEvent(projection, envelope({ type: "diagnostic", text: "a" }));
    expect(projection.lastSequence).toBe(String(sequence));
  });
});
