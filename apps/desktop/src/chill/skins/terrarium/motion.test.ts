import { describe, expect, it } from "vitest";
import { activityOf, climbPath, planLeg, type Tree } from "./motion";

const tree: Tree = {
  trunkX: 600,
  baseY: 540,
  perches: [
    { x: 520, y: 380 },
    { x: 680, y: 360 },
    { x: 560, y: 300 },
    { x: 650, y: 280 },
  ],
};
const home = { x: 508, y: 573, inward: 1 };

describe("helper motion", () => {
  it("reads each kind of work from the reported operation", () => {
    expect(activityOf("working", "edit")).toBe("editing");
    expect(activityOf("working", "search")).toBe("reading");
    expect(activityOf("working", "build")).toBe("running");
    expect(activityOf("starting", "thinking")).toBe("thinking");
    expect(activityOf("waiting", "edit")).toBe("waiting");
    expect(activityOf("idle", "idle")).toBe("idle");
  });

  it("climbs the trunk to reach a leaf and back down to come home", () => {
    const up = climbPath(home, { x: 680, y: 360 }, tree);
    expect(up).toEqual([
      { x: 600, y: 540 },
      { x: 600, y: 360 },
      { x: 680, y: 360 },
    ]);
    const across = climbPath({ x: 680, y: 360 }, { x: 520, y: 380 }, tree);
    expect(across[0]).toEqual({ x: 600, y: 360 });
    expect(across.at(-1)).toEqual({ x: 520, y: 380 });
    const down = climbPath({ x: 520, y: 380 }, home, tree);
    expect(down.at(-2)).toEqual({ x: 600, y: 540 });
    expect(down.at(-1)).toEqual(home);
  });

  it("running commands alternates the desk with trips up the plant", () => {
    const legs = [0, 1, 2, 3].map((step) => planLeg("running", home, home, tree, null, 7, step));
    expect(legs.map((leg) => leg.spot)).toEqual(["desk", "branch", "desk", "branch"]);
    expect(legs[1]!.path.at(-1)!.y).toBeLessThan(tree.baseY);
  });

  it("an editing helper works at its file and visits a neighbouring leaf", () => {
    const file = { x: 680, y: 360 };
    const spots = [0, 1, 2].map((step) => planLeg("editing", home, home, tree, file, 3, step).spot);
    expect(spots).toEqual(["file", "file", "branch"]);
    const away = planLeg("editing", file, home, tree, file, 3, 2).path.at(-1)!;
    expect(away).not.toEqual(file);
  });

  it("an idle helper potters near home without climbing", () => {
    for (let step = 0; step < 8; step++) {
      const end = planLeg("idle", home, home, tree, null, 11, step).path.at(-1)!;
      expect(Math.abs(end.x - home.x)).toBeLessThanOrEqual(28);
      expect(end.y).toBeGreaterThan(tree.baseY);
    }
  });
});
