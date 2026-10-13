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

/** A thoughtful work loop for tools without a trustworthy file target.
 * This animates the helper, never invents a file or claims a tool succeeded.
 */
export function workDestination(home: Home, seconds: number, phase: number) {
  const step = Math.floor(((seconds + (phase % 5) * 0.7) % 16) / 4);
  const inward = home.inward;
  const offsets = [
    [inward * 32, -40],
    [-inward * 12, -62],
    [0, 0],
    [0, 0],
  ];
  const [x, y] = offsets[step]!;
  return { x: home.x + x!, y: home.y + y!, atDesk: step >= 2 };
}
