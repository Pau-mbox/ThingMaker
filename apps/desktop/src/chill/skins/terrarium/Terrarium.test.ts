import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../preferences";
import { toTerrarium } from "./model";
import type { ActivityActorView, ActivityProject } from "../../model";

// Retain the scene graph and ticker callbacks while replacing GPU/Canvas IO.
// These tests exercise the real renderer's update, animation and cleanup paths.
const graphics = vi.hoisted(() => ({ applications: [] as any[] }));
vi.mock("pixi.js/unsafe-eval", () => ({}));
vi.mock("pixi.js", () => {
  class Container {
    children: any[] = [];
    x = 0;
    y = 0;
    rotation = 0;
    alpha = 1;
    visible = true;
    destroyed = false;
    parent: Container | null = null;
    position = {
      set: (x: number, y = x) => {
        this.x = x;
        this.y = y;
      },
    };
    scale = {
      x: 1,
      y: 1,
      set: (x: number, y = x) => {
        this.scale.x = x;
        this.scale.y = y;
      },
    };
    addChild(child: any) {
      this.children.push(child);
      child.parent = this;
      return child;
    }
    addChildAt(child: any, index: number) {
      this.children.splice(index, 0, child);
      child.parent = this;
      return child;
    }
    setChildIndex(child: any, index: number) {
      this.children.splice(this.children.indexOf(child), 1);
      this.children.splice(index, 0, child);
    }
    removeChildren() {
      return this.children.splice(0);
    }
    on() {
      return this;
    }
    destroy() {
      this.destroyed = true;
      this.children.slice().forEach((c) => c.destroy());
      if (this.parent)
        this.parent.children.splice(this.parent.children.indexOf(this), 1);
    }
  }
  class Graphics extends Container {
    constructor() {
      super();
      return new Proxy(this, {
        get: (target, key, receiver) =>
          key in target ? Reflect.get(target, key, receiver) : () => receiver,
      });
    }
  }
  class Text extends Container {
    text: string;
    height = 16;
    anchor = { set: vi.fn() };
    constructor({ text }: { text: string }) {
      super();
      this.text = text;
    }
  }
  class Application {
    stage = new Container();
    canvas = document.createElement("canvas");
    screen = { width: 1200, height: 760 };
    renderer = { background: { color: 0 }, resolution: 1, resize: vi.fn() };
    render = vi.fn();
    ticker = {
      started: false,
      maxFPS: 60,
      callbacks: [] as (() => void)[],
      add: (fn: () => void) => this.ticker.callbacks.push(fn),
      remove: (fn: () => void) => {
        this.ticker.callbacks = this.ticker.callbacks.filter((c) => c !== fn);
      },
      start: () => {
        this.ticker.started = true;
      },
      stop: () => {
        this.ticker.started = false;
      },
    };
    async init() {
      graphics.applications.push(this);
    }
    destroy() {
      this.ticker.stop();
      this.stage.destroy();
      this.canvas.remove();
    }
  }
  return { Application, Container, Graphics, Text };
});
import { Terrarium } from "./Terrarium";

const now = Date.now();
const actor: ActivityActorView = {
  id: "root",
  sessionId: "root",
  workspaceId: "project",
  parentId: null,
  name: "Root",
  provider: "claude",
  model: null,
  status: "working",
  task: "Review",
  operation: "thinking",
  fileId: null,
  native: false,
  generation: "1",
  lastSeen: now,
  lastActiveAt: now,
  reason: null,
  retryAt: null,
  jobId: null,
  orchestrator: null,
};
function project(actors = [actor]): ActivityProject {
  return {
    id: "project",
    name: "Project",
    root: "/project",
    actors,
    files: [],
    goals: [],
  };
}
async function renderer() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const host = document.createElement("div");
  const scene = await Terrarium.create(host, DEFAULT_PREFS, () => {});
  return { scene, app: graphics.applications.at(-1)!, host };
}
// Tests inspect retained visual positions rather than a second motion algorithm.
function bugs(scene: Terrarium) {
  return [...(scene as unknown as { bugs: Map<string, any> }).bugs.values()];
}
function advance(app: any, frames: number, clock: { value: number }) {
  for (let i = 0; i < frames; i++) {
    clock.value += 1000 / 60;
    if (app.ticker.started)
      app.ticker.callbacks.forEach((fn: () => void) => fn());
  }
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  graphics.applications.length = 0;
});
describe("terrarium live work", () => {
  it("walks visibly while thinking without a file target, and keeps jobs intact when frozen", async () => {
    const clock = { value: 1000 };
    vi.spyOn(performance, "now").mockImplementation(() => clock.value);
    const { scene, app, host } = await renderer();
    const data = [toTerrarium(project(), now)];
    scene.update(data, DEFAULT_PREFS, false, null, null, now);
    const bug = bugs(scene)[0]!;
    const initial = { x: bug.x, y: bug.y };
    advance(app, 120, clock);
    expect(Math.hypot(bug.x - initial.x, bug.y - initial.y)).toBeGreaterThan(
      30,
    );
    expect(bug.art.thought.visible).toBe(true);
    expect(bug.art.bench.visible).toBe(false);
    expect(bug.bug.status).toBe("working");
    scene.update(
      data,
      { ...DEFAULT_PREFS, freeze: true },
      false,
      null,
      null,
      now,
    );
    const frozen = { x: bug.x, y: bug.y };
    advance(app, 120, clock);
    expect({ x: bug.x, y: bug.y }).toEqual(frozen);
    expect(app.ticker.started).toBe(false);
    expect(bug.bug.status).toBe("working");
    scene.destroy();
    expect(host.querySelector("canvas")).toBeNull();
    expect(app.ticker.callbacks).toHaveLength(0);
  });
  it("retires historical helpers and separates the resting places of current sessions", async () => {
    const { scene } = await renderer();
    const actors = [
      actor,
      { ...actor, id: "second", status: "idle" },
      { ...actor, id: "third", status: "idle" },
      ...Array.from({ length: 22 }, (_, i) => ({
        ...actor,
        id: `historical-${i}`,
        native: true,
        status: "idle",
        parentId: "root",
        lastActiveAt: null,
      })),
    ];
    scene.update(
      [toTerrarium(project(actors), now)],
      DEFAULT_PREFS,
      false,
      null,
      null,
      now,
    );
    const shown = bugs(scene);
    expect(shown).toHaveLength(3);
    for (let i = 0; i < shown.length; i++)
      for (let j = i + 1; j < shown.length; j++)
        expect(
          Math.hypot(
            shown[i].home.x - shown[j].home.x,
            shown[i].home.y - shown[j].home.y,
          ),
        ).toBeGreaterThan(50);
    scene.destroy();
  });
  it("moves to a real file perch and stops roaming when awaiting input or using reduced motion", async () => {
    const clock = { value: 1000 };
    vi.spyOn(performance, "now").mockImplementation(() => clock.value);
    const { scene, app } = await renderer();
    const p = project([{ ...actor, fileId: "file", operation: "read" }]);
    p.files = [
      {
        id: "file",
        workspaceId: "project",
        path: "chapter.yaml",
        external: false,
        operation: "read",
        touchedAt: now,
        sessionId: "root",
        activeActors: ["root"],
      },
    ];
    scene.update([toTerrarium(p, now)], DEFAULT_PREFS, false, null, null, now);
    const bug = bugs(scene)[0]!;
    advance(app, 240, clock);
    expect(bug.y).toBeLessThan(bug.home.y - 100);
    expect(bug.art.lens.visible).toBe(true);
    p.actors[0] = { ...actor, status: "attention" };
    scene.update([toTerrarium(p, now)], DEFAULT_PREFS, false, null, null, now);
    advance(app, 240, clock);
    expect(Math.hypot(bug.x - bug.home.x, bug.y - bug.home.y)).toBeLessThan(1);
    expect(bug.art.thought.visible).toBe(false);
    scene.update(
      [toTerrarium(project(), now)],
      DEFAULT_PREFS,
      true,
      null,
      null,
      now,
    );
    expect(app.ticker.started).toBe(false);
    expect(bug.bug.status).toBe("working");
    scene.destroy();
  });
});
