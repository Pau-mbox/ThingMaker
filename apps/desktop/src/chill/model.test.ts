import { describe, it, expect } from "vitest";
import type {
  ActivityActor,
  ActivitySnapshot,
  FileActivity,
  JobView,
  WorkspaceRecord,
} from "@thingmaker/contracts";
import { EMPTY, projectsOf, ageLabel } from "./model";
import { DEFAULT_PREFS, readPrefs } from "./preferences";
import { resolveSkin, skinOptions, SKINS } from "./skins/registry";
import { focusCamera } from "./skins/terrarium/camera";
import { leafScale, visibleFiles, toTerrarium } from "./skins/terrarium/model";
const now = 1_800_000_000_000;
const workspace: WorkspaceRecord = {
  id: "w",
  environmentId: "local",
  canonicalRoot: "/repo",
  displayPath: "/repo",
  workspaceHash: "w",
  trustState: "trusted_local",
  createdAt: now,
};
const actor: ActivityActor = {
  id: "s",
  sessionId: "s",
  workspaceId: "w",
  parentId: null,
  name: "Keeper",
  provider: "claude",
  model: null,
  status: "working",
  task: "Develop",
  operation: "thinking",
  fileId: null,
  lastSeen: now,
  native: false,
  generation: "1",
};
const file: FileActivity = {
  id: "w:a",
  workspaceId: "w",
  path: "a",
  external: false,
  operation: "edit",
  touchedAt: now,
  sessionId: "s",
  activeActors: [],
};
function snapshot(partial: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return { ...EMPTY, actors: [actor], ...partial };
}
function job(partial: Partial<JobView> = {}): JobView {
  return {
    id: "j",
    orchestrator: "s",
    worker: "Builder",
    provider: "codex",
    task: "Implement",
    status: "running",
    startedAtUnixMs: now,
    workerSession: "worker",
    ...partial,
  } as JobView;
}
describe("skin-independent activity", () => {
  it("deduplicates reused workers by session and takes the newest job", () => {
    const data = snapshot({
      actors: [actor, { ...actor, id: "worker", sessionId: "worker" }],
      jobs: [
        job({ id: "old", status: "succeeded", startedAtUnixMs: now - 100 }),
        job({ id: "new", task: "Review the update" }),
      ],
    });
    const project = projectsOf(data, [workspace], now)[0]!;
    expect(project.actors).toHaveLength(2);
    expect(project.actors.find((a) => a.id === "worker")?.jobId).toBe("new");
    expect("role" in project.actors[0]!).toBe(false);
  });
  it("represents a queued job before its worker attaches and preserves its retry evidence", () => {
    const waiting = job({
      status: "waiting",
      waitingReason: "Quota",
      retryAtUnixMs: now + 1000,
    });
    delete waiting.workerSession;
    const project = projectsOf(
      snapshot({ jobs: [waiting] }),
      [workspace],
      now,
    )[0]!;
    expect(project.actors[1]).toMatchObject({
      id: "job:j",
      status: "waiting",
      reason: "Quota",
      retryAt: now + 1000,
      parentId: "s",
    });
  });
  it("does not resurrect a completed detached worker", () => {
    expect(
      projectsOf(
        snapshot({ jobs: [job({ status: "succeeded" })] }),
        [workspace],
        now,
      )[0]!.actors,
    ).toHaveLength(1);
  });
  it("marks silent actors uncertain and releases active-file presentation", () => {
    const p = projectsOf(
      snapshot({
        actors: [{ ...actor, lastSeen: now - 11 * 60_000 }],
        files: [{ ...file, activeActors: ["s"] }],
      }),
      [workspace],
      now,
    )[0]!;
    expect(p.actors[0]!.status).toBe("unknown");
    expect(p.files[0]!.activeActors).toEqual([]);
  });
  it("keeps a worktree's real identity and source branch", () => {
    const tree = { ...workspace, id: "tree", displayPath: "/worktrees/abc" };
    const p = projectsOf(
      snapshot({
        worktrees: [
          { workspaceId: "tree", sourceWorkspaceId: "w", branch: "codex/cozy" },
        ],
      }),
      [workspace, tree],
      now,
    )[1]!;
    expect(p.id).toBe("tree");
    expect(p.name).toBe("repo · codex/cozy");
  });
  it("clamps wall clock regressions without inventing recency for replay", () => {
    expect(ageLabel(now + 100, now)).toBe("Just now");
    expect(ageLabel(0, now)).toBe("Recency unknown");
  });
});
describe("terrarium interpretation", () => {
  it("owns role assignment and leaves the source facts intact", () => {
    const p = projectsOf(
      snapshot({ actors: [{ ...actor, task: "Review" }] }),
      [workspace],
      now,
    )[0]!;
    expect(toTerrarium(p).bugs[0]!.role).toBe("bee");
    expect("role" in p.actors[0]!).toBe(false);
  });
  it("keeps replayed helpers in activity history without crowding the current work", () => {
    const p = projectsOf(
      snapshot({
        actors: [
          actor,
          ...Array.from({ length: 22 }, (_, i) => ({
            ...actor,
            id: `old-${i}`,
            native: true,
            parentId: "s",
            status: "idle",
            lastSeen: now,
            lastActiveAt: null,
          })),
        ],
      }),
      [workspace],
      now,
    )[0]!;
    expect(p.actors).toHaveLength(23);
    expect(toTerrarium(p, now).bugs.map((b) => b.id)).toEqual(["s"]);
    expect(
      toTerrarium(p, now, { kind: "actor", id: "old-4" }).bugs.map((b) => b.id),
    ).toEqual(["s", "old-4"]);
  });
  it("keeps real working children and gives live completions a short farewell", () => {
    const p = projectsOf(
      snapshot({
        actors: [
          actor,
          {
            ...actor,
            id: "child",
            native: true,
            parentId: "s",
            lastActiveAt: now - 1000,
          },
          {
            ...actor,
            id: "done",
            native: true,
            parentId: "s",
            status: "idle",
            lastActiveAt: now - 1000,
          },
        ],
      }),
      [workspace],
      now,
    )[0]!;
    expect(toTerrarium(p, now).bugs.map((b) => b.id)).toEqual([
      "s",
      "child",
      "done",
    ]);
    expect(toTerrarium(p, now + 13_000).bugs.map((b) => b.id)).toEqual([
      "s",
      "child",
    ]);
  });
  it("shrinks old foliage continuously but retains active and pinned leaves", () => {
    expect(leafScale(file, now)).toBe(1);
    expect(leafScale({ ...file, touchedAt: now - 30 * 60_000 }, now)).toBe(0.8);
    expect(leafScale({ ...file, touchedAt: now - 120 * 60_000 }, now)).toBe(
      0.55,
    );
    expect(leafScale({ ...file, touchedAt: 0, activeActors: ["s"] }, now)).toBe(
      1,
    );
    expect(leafScale({ ...file, touchedAt: 0 }, now, true)).toBe(1);
  });
  it("retains selected, pinned and active files through aggregation", () => {
    const files = Array.from({ length: 100 }, (_, i) => ({
      ...file,
      id: `f${i}`,
      touchedAt: now - i,
    }));
    files[99] = { ...file, id: "active", touchedAt: 0, activeActors: ["s"] };
    files[98] = { ...file, id: "pin", touchedAt: 1 };
    files[97] = { ...file, id: "selected", touchedAt: 1 };
    const p = toTerrarium(
      projectsOf(snapshot({ files }), [workspace], now)[0]!,
    );
    const result = visibleFiles(
      p,
      { ...DEFAULT_PREFS, pins: ["pin"] },
      now,
      false,
      { kind: "file", id: "selected" },
    );
    expect(result.files).toHaveLength(24);
    expect(result.clustered).toBe(76);
    expect(result.files.slice(0, 3).map((f) => f.id)).toEqual([
      "selected",
      "active",
      "pin",
    ]);
    expect(visibleFiles(p, DEFAULT_PREFS, now, true, null).files).toHaveLength(
      80,
    );
  });
});
describe("skin preferences", () => {
  it("ships only Terrarium and safely falls back from missing skins", () => {
    expect(SKINS.map((s) => s.id)).toEqual(["terrarium"]);
    expect(resolveSkin("removed-skin").id).toBe("terrarium");
  });
  it("validates each skin's options and always restores muted", () => {
    const prefs = readPrefs({
      skinId: "terrarium",
      skinOptions: { terrarium: { light: "garbage" } },
      sound: true,
      volume: 12,
      pins: [1, "file"],
    });
    expect(skinOptions(resolveSkin(prefs.skinId), prefs)).toEqual({
      light: "dusk",
    });
    expect(prefs.sound).toBe(false);
    expect(prefs.volume).toBe(1);
    expect(prefs.pins).toEqual(["file"]);
  });
  it("migrates the original atmosphere setting into the terrarium skin", () => {
    const p = readPrefs({ atmosphere: "moonlight" });
    expect(skinOptions(resolveSkin(p.skinId), p).light).toBe("moonlight");
  });
});

describe("terrarium camera", () => {
  it("keeps the whole selected tree and its perches inside the dome at every project position", () => {
    for (const [x, y, hero] of [
      [600, 553, true],
      [590, 510, true],
      [290, 555, false],
      [890, 550, false],
      [430, 605, false],
      [710, 610, false],
      [1020, 600, false],
    ] as const) {
      const camera = focusCamera(x, y, hero);
      const top = hero ? -310 : -215;
      expect((x - 140) * camera.zoom + camera.x).toBeGreaterThanOrEqual(210);
      expect((x + 140) * camera.zoom + camera.x).toBeLessThanOrEqual(990);
      expect((y + top) * camera.zoom + camera.y).toBeGreaterThanOrEqual(209.99);
      expect((y + 55) * camera.zoom + camera.y).toBeLessThanOrEqual(630.01);
    }
  });
});
