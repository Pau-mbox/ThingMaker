export type Point = { x: number; y: number };
export type Home = Point & { inward: number };

/** Separated resting places, bounded by the project's camera framing. */
export function helperHome(slot: number, origin: Point): Home {
  const columns = [-92, 92, -30, 30];
  return {
    x: origin.x + columns[slot % 4]!,
    y: origin.y + 20 - Math.floor(slot / 4) * 46,
    inward: columns[slot % 4]! < 0 ? 1 : -1,
  };
}

/**
 * What a helper is visibly doing. Derived from the reported status and
 * operation only: the animation never invents a file or claims a tool
 * succeeded, it just keeps a working helper in motion.
 */
export type Activity = "idle" | "waiting" | "thinking" | "reading" | "editing" | "running";

export function activityOf(status: string, operation: string): Activity {
  if (status === "idle" || status === "unknown") return "idle";
  if (status !== "working" && status !== "starting") return "waiting";
  if (["edit", "write", "create", "delete", "rename"].includes(operation)) return "editing";
  if (["read", "search"].includes(operation)) return "reading";
  if (["build", "execute", "test"].includes(operation)) return "running";
  return "thinking";
}

/** Where a leg ends, which decides the props shown while the helper dwells. */
export type Spot = "ground" | "desk" | "branch" | "file";
export type Leg = { path: Point[]; dwell: number; spot: Spot };

/** The plant a helper climbs, in scene coordinates. */
export type Tree = {
  /** The trunk's x, and the y where climbing starts (the pot's rim). */
  trunkX: number;
  baseY: number;
  /** Places a helper can sit: the plant's leaves and branch tips. */
  perches: Point[];
};

/** A repeatable 0..1 sequence per helper, so each one has its own habits. */
export function chance(seed: number, step: number, salt = 0): number {
  const value = Math.sin(seed * 12.9898 + step * 78.233 + salt * 37.719) * 43758.5453;
  return value - Math.floor(value);
}

const onTree = (point: Point, tree: Tree) => point.y < tree.baseY - 6;

/**
 * The way from one place to another over the plant: along a branch back to
 * the trunk, up or down the trunk, out along a branch. Walking on the
 * ground goes straight.
 */
export function climbPath(from: Point, to: Point, tree: Tree): Point[] {
  const path: Point[] = [];
  const fromTree = onTree(from, tree);
  const toTree = onTree(to, tree);
  if (!fromTree && !toTree) return [to];
  path.push(fromTree ? { x: tree.trunkX, y: from.y } : { x: tree.trunkX, y: tree.baseY });
  if (toTree) path.push({ x: tree.trunkX, y: to.y });
  else path.push({ x: tree.trunkX, y: tree.baseY });
  path.push(to);
  return path.filter((point, i) => {
    const previous = i === 0 ? from : path[i - 1]!;
    return Math.hypot(point.x - previous.x, point.y - previous.y) > 1;
  });
}

function pick(tree: Tree, seed: number, step: number, near?: Point): Point | null {
  if (tree.perches.length === 0) return null;
  if (!near) return tree.perches[Math.floor(chance(seed, step, 1) * tree.perches.length)]!;
  // A neighbour of the file: one of the three closest perches.
  const closest = [...tree.perches]
    .sort((a, b) => Math.hypot(a.x - near.x, a.y - near.y) - Math.hypot(b.x - near.x, b.y - near.y))
    .slice(1, 4);
  return closest[Math.floor(chance(seed, step, 2) * closest.length)] ?? null;
}

/**
 * The helper's next leg: where it goes from `from`, and how long it stays.
 * `step` counts legs, so a helper alternates between its habits.
 */
export function planLeg(
  activity: Activity,
  from: Point,
  home: Home,
  tree: Tree,
  file: Point | null,
  seed: number,
  step: number,
): Leg {
  const r = (salt: number) => chance(seed, step, salt);
  const go = (to: Point, dwell: number, spot: Spot): Leg => ({ path: climbPath(from, to, tree), dwell, spot });
  const perch = (near?: Point) => pick(tree, seed, step, near);
  switch (activity) {
    case "waiting":
      return go(home, 2 + r(3) * 2, "ground");
    case "idle": {
      // Pottering about near home: a few steps, a rest.
      const spot = { x: home.x + (r(3) - 0.5) * 56, y: home.y + (r(4) - 0.5) * 14 };
      return go(spot, 2.5 + r(5) * 4, "ground");
    }
    case "editing": {
      // Works at the file, stepping to a neighbouring leaf now and then.
      if (file && step % 3 !== 2) return go(file, 3 + r(3) * 3, "file");
      const next = perch(file ?? undefined);
      return next ? go(next, 1.2 + r(3), "branch") : go(home, 2, "ground");
    }
    case "reading": {
      // Leaf to leaf with the magnifier, back to the file every few hops.
      if (file && step % 3 === 0) return go(file, 2 + r(3) * 1.5, "file");
      const next = perch();
      return next ? go(next, 1.2 + r(3) * 1.5, "branch") : go(home, 2, "desk");
    }
    case "running": {
      // Types at the desk, climbs up to look at what it did, comes back.
      if (step % 2 === 0) return go(home, 2.5 + r(3) * 2, "desk");
      const next = perch();
      return next ? go(next, 1.5 + r(3) * 1.5, "branch") : go(home, 2, "desk");
    }
    case "thinking": {
      if (step % 2 === 0) {
        const next = perch();
        if (next) return go(next, 2.5 + r(3) * 2, "branch");
      }
      const angle = r(5) * Math.PI * 2;
      return go({ x: tree.trunkX + Math.cos(angle) * 70, y: tree.baseY + 26 + Math.sin(angle) * 10 }, 2 + r(3) * 2, "ground");
    }
  }
}

/** Walking on the ground is quicker than climbing. */
export function speedFor(from: Point, to: Point): number {
  return Math.abs(to.y - from.y) > Math.abs(to.x - from.x) ? 95 : 120;
}
