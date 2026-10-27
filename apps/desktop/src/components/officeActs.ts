/**
 * What the crew does when it is not working. A robot that is ready or done
 * stays at its desk; every IDLE_MS it may get up (ACT_CHANCE) and do
 * something in the office: pet the witch, nap on the sofa, get a drink or a
 * coffee, dance. It walks there through the aisles, does it for a while, and
 * walks back. The moment it has work again, it drops what it is doing and
 * goes back to its desk.
 *
 * Nothing here is a report from an agent: it is only the room being lived in,
 * so it never touches what a robot's state, plate or bubble says. Places are
 * in the room's own units (see officeArt); the scene turns them into CSS.
 */
import { useEffect, useRef, useState } from "react";
import type { CrewMember } from "./crew";

export type Act = "pet" | "siesta" | "drink" | "coffee" | "dance";
export type Point = { x: number; y: number };
/** Where a robot is when it is off its desk: walking to the next point (taking `leg` seconds), or doing `act`. */
export type Move = Point & { act: Act | null; walking: boolean; leg: number };

/** How long a robot sits idle before it may get up, and how likely it is to. */
export const IDLE_MS = 5000;
export const ACT_CHANCE = 0.6;
/** How long each act lasts. */
export const ACT_MS: Record<Act, number> = { pet: 3500, siesta: 7000, drink: 3000, coffee: 3500, dance: 5000 };
export const ACTS: readonly Act[] = ["pet", "siesta", "drink", "coffee", "dance"];
/** Room units a robot walks in a second. */
const SPEED = 30;

/** Where each act is done, as standing places (feet), for a room whose lounge has moved `dy` from where three rows put it. */
export function actSpots(act: Act, dy: number): Point[] {
  switch (act) {
    case "pet":
      return [{ x: 15, y: 92 }, { x: 25, y: 97 }];
    case "siesta":
      return [{ x: 22, y: 240 + dy }, { x: 38, y: 240 + dy }];
    case "drink":
      return [{ x: 121, y: 251 + dy }, { x: 111, y: 255 + dy }];
    case "coffee":
      return [{ x: 134, y: 249 + dy }, { x: 144, y: 255 + dy }];
    case "dance":
      return [{ x: 80, y: 272 + dy }, { x: 50, y: 276 + dy }, { x: 110, y: 272 + dy }, { x: 25, y: 268 + dy }];
  }
}

/** The gaps between desk columns, and the two sides: where a robot can walk down past the desks. */
export function aisles(xs: readonly number[]): number[] {
  const mids = xs.slice(1).map((x, i) => ((xs[i] as number) + x) / 2);
  return [Math.max(14, (xs[0] as number) - 28), ...mids, Math.min(146, (xs[xs.length - 1] as number) + 28)];
}

const nearest = (values: number[], x: number) => values.reduce((best, value) => (Math.abs(value - x) < Math.abs(best - x) ? value : best));

function tidy(points: Point[], from: Point): Point[] {
  const out: Point[] = [];
  let last = from;
  for (const point of points) {
    if (Math.hypot(point.x - last.x, point.y - last.y) < 0.5) continue;
    out.push(point);
    last = point;
  }
  return out;
}

/** From a desk's seat, out the front, along the row to an aisle, down it, and across to the spot. */
export function routeFromDesk(seat: Point, spot: Point, aisleXs: number[]): Point[] {
  const front = seat.y + 20;
  const aisle = nearest(aisleXs, spot.x);
  return tidy([{ x: seat.x, y: front }, { x: aisle, y: front }, { x: aisle, y: spot.y }, spot], seat);
}

/** The way back: to an aisle, along it to the desk's row, across the front, and in to the seat. */
export function routeToDesk(from: Point, seat: Point, aisleXs: number[]): Point[] {
  const front = seat.y + 20;
  const aisle = nearest(aisleXs, from.x);
  return tidy([{ x: aisle, y: from.y }, { x: aisle, y: front }, { x: seat.x, y: front }, seat], from);
}

type Latest = { crew: CrewMember[]; seats: Point[]; dy: number; aisleXs: number[] };
type Options = { rng?: () => number; idleMs?: number; chance?: number; enabled?: boolean };

/** Runs the idle timers and the walks; publishes a robot's move, or null when it is back at its desk. */
class Director {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private acting = new Map<string, { act: Act; slot: number; at: Point }>();
  private taken = new Map<Act, Set<number>>();
  private closed = false;

  constructor(
    private latest: () => Latest,
    private publish: (key: string, move: Move | null) => void,
    private options: () => Required<Options>,
  ) {}

  /** Brings the timers in line with who is working now. Safe to call as often as the crew changes. */
  sync(): void {
    const { crew } = this.latest();
    const keys = new Set(crew.map((member) => member.key));
    for (const key of [...this.timers.keys(), ...this.acting.keys()]) if (!keys.has(key)) this.forget(key);
    for (const member of crew) {
      if (member.state === "working") this.stop(member.key);
      else if (!this.timers.has(member.key) && !this.acting.has(member.key)) this.wait(member.key);
    }
  }

  close(): void {
    this.closed = true;
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    this.acting.clear();
  }

  /** Everyone goes back to their desk where they stand, and the timers start over (the room changed shape). */
  reset(): void {
    for (const key of [...this.timers.keys(), ...this.acting.keys()]) this.forget(key);
    this.sync();
  }

  private forget(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.release(key);
    this.acting.delete(key);
    this.publish(key, null);
  }

  private release(key: string): void {
    const acting = this.acting.get(key);
    if (acting) this.taken.get(acting.act)?.delete(acting.slot);
  }

  private after(key: string, ms: number, run: () => void): void {
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        if (!this.closed) run();
      }, ms),
    );
  }

  private wait(key: string): void {
    this.after(key, this.options().idleMs, () => this.roll(key));
  }

  private roll(key: string): void {
    const member = this.latest().crew.find((entry) => entry.key === key);
    if (!member || member.state === "working") return;
    const { rng, chance } = this.options();
    if (rng() >= chance) return this.wait(key);
    const { dy } = this.latest();
    const first = Math.floor(rng() * ACTS.length);
    for (let i = 0; i < ACTS.length; i += 1) {
      const act = ACTS[(first + i) % ACTS.length] as Act;
      const used = this.taken.get(act) ?? new Set<number>();
      const slot = actSpots(act, dy).findIndex((_, index) => !used.has(index));
      if (slot < 0) continue;
      used.add(slot);
      this.taken.set(act, used);
      return this.go(key, act, slot);
    }
    this.wait(key);
  }

  private seat(key: string): Point | null {
    const { crew, seats } = this.latest();
    const index = crew.findIndex((entry) => entry.key === key);
    return index < 0 ? null : (seats[index] ?? null);
  }

  private go(key: string, act: Act, slot: number): void {
    const seat = this.seat(key);
    if (!seat) return this.release2(key, act, slot);
    const { dy, aisleXs } = this.latest();
    const spot = actSpots(act, dy)[slot] as Point;
    this.acting.set(key, { act, slot, at: seat });
    this.walk(key, routeFromDesk(seat, spot, aisleXs), () => this.perform(key, act, spot));
  }

  private release2(key: string, act: Act, slot: number): void {
    this.taken.get(act)?.delete(slot);
    this.wait(key);
  }

  /** Walks the points in turn, each leg taking as long as its length needs, then calls `done`. */
  private walk(key: string, points: Point[], done: () => void): void {
    const acting = this.acting.get(key);
    if (!acting) return;
    const step = (i: number) => {
      const next = points[i];
      if (!next) return done();
      const ms = Math.max(300, (Math.hypot(next.x - acting.at.x, next.y - acting.at.y) / SPEED) * 1000);
      acting.at = next;
      this.publish(key, { ...next, act: null, walking: true, leg: ms / 1000 });
      this.after(key, ms, () => step(i + 1));
    };
    step(0);
  }

  private perform(key: string, act: Act, spot: Point): void {
    this.publish(key, { ...spot, act, walking: false, leg: 0 });
    this.after(key, ACT_MS[act], () => this.home(key, false));
  }

  /** Back to the desk. `busy` is whether it goes because it has work: then no new idle timer starts. */
  private home(key: string, busy: boolean): void {
    const acting = this.acting.get(key);
    const seat = this.seat(key);
    if (!acting || !seat) return;
    const { aisleXs } = this.latest();
    this.walk(key, routeToDesk(acting.at, seat, aisleXs), () => {
      this.release(key);
      this.acting.delete(key);
      this.publish(key, null);
      const member = this.latest().crew.find((entry) => entry.key === key);
      if (!busy && member && member.state !== "working") this.wait(key);
    });
  }

  private stop(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    if (this.acting.has(key)) this.home(key, true);
  }
}

/** Where each idle robot is, when it is off its desk. Robots at their desks are not in the result. */
export function useIdleActs(crew: CrewMember[], seats: Point[], dy: number, xs: readonly number[], options: Options = {}): Record<string, Move> {
  const [moves, setMoves] = useState<Record<string, Move>>({});
  const aisleXs = aisles(xs);
  const latest = useRef<Latest>({ crew, seats, dy, aisleXs });
  latest.current = { crew, seats, dy, aisleXs };
  const settings = useRef<Required<Options>>({ rng: Math.random, idleMs: IDLE_MS, chance: ACT_CHANCE, enabled: true });
  settings.current = { rng: options.rng ?? Math.random, idleMs: options.idleMs ?? IDLE_MS, chance: options.chance ?? ACT_CHANCE, enabled: options.enabled ?? true };
  const director = useRef<Director | null>(null);
  const enabled = settings.current.enabled;

  useEffect(() => {
    if (!enabled) {
      setMoves({});
      return;
    }
    const made = new Director(
      () => latest.current,
      (key, move) =>
        setMoves((known) => {
          if (!move) {
            if (!(key in known)) return known;
            const { [key]: _gone, ...rest } = known;
            return rest;
          }
          return { ...known, [key]: move };
        }),
      () => settings.current,
    );
    director.current = made;
    made.sync();
    return () => {
      made.close();
      director.current = null;
    };
  }, [enabled]);

  // Who is working changes as often as the crew does; the room's shape rarely does.
  const signature = crew.map((member) => `${member.key}:${member.state === "working" ? "w" : "i"}`).join("|");
  useEffect(() => director.current?.sync(), [signature]);
  const shape = `${dy}|${xs.join(",")}|${seats.map((seat) => `${seat.x},${seat.y}`).join(";")}`;
  const shaped = useRef(shape);
  useEffect(() => {
    if (shaped.current === shape) return;
    shaped.current = shape;
    director.current?.reset();
  }, [shape]);

  return moves;
}
