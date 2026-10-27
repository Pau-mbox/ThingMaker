/** What the crew does when it is not working: wait, get up, do something, walk back. */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACT_MS, IDLE_MS, actSpots, aisles, routeFromDesk, routeToDesk, useIdleActs } from "./components/officeActs";
import type { CrewMember } from "./components/crew";

const member = (key: string, state: CrewMember["state"]): CrewMember => ({ key, provider: "claude", role: "coder", name: key, state, status: "", title: "", kind: "helper", model: null, task: "" });
const seat = (i: number) => ({ x: 28 + i * 52, y: 116 });
const run = (crew: CrewMember[], rng = () => 0) => renderHook(({ crew }) => useIdleActs(crew, crew.map((_, i) => seat(i)), 0, [28, 80, 132], { rng }), { initialProps: { crew } });
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("routes", () => {
  it("leave by the front of the desk, go down an aisle and end at the spot", () => {
    const spot = actSpots("siesta", 0)[0]!;
    const route = routeFromDesk(seat(0), spot, aisles([28, 80, 132]));
    expect(route[0]).toEqual({ x: 28, y: 136 });
    expect(route.at(-1)).toEqual(spot);
    // The aisle is between desk columns or at a side, never through a desk.
    expect([14, 54, 106, 146]).toContain(route[1]!.x);
  });

  it("come back in through the front of the desk and end on the seat", () => {
    const route = routeToDesk({ x: 100, y: 250 }, seat(1), aisles([28, 80, 132]));
    expect(route.at(-1)).toEqual(seat(1));
    expect(route.at(-2)).toEqual({ x: 80, y: 136 });
  });
});

describe("an idle robot", () => {
  it("stays at its desk for the first five seconds, then may get up and walk", () => {
    const { result } = run([member("a", "idle")]);
    tick(IDLE_MS - 100);
    expect(result.current).toEqual({});
    tick(200);
    expect(result.current.a).toMatchObject({ walking: true, act: null });
  });

  it("does its act at the spot, then walks back to its desk", () => {
    const { result } = run([member("a", "idle")]);
    let seen = false;
    for (let t = 0; t < 40_000 && !seen; t += 250) {
      tick(250);
      seen = result.current.a?.act === "pet";
    }
    // rng is 0: the first act, petting the witch, standing at its first spot.
    expect(result.current.a).toMatchObject({ act: "pet", walking: false, ...actSpots("pet", 0)[0] });
    // The act ends, and it walks back: first walking, then at its desk (no move).
    tick(ACT_MS.pet + 100);
    expect(result.current.a).toMatchObject({ walking: true });
    for (let t = 0; t < 30_000 && result.current.a; t += 250) tick(250);
    expect(result.current.a).toBeUndefined();
  });

  it("never gets up when the chance is nil", () => {
    const { result } = renderHook(() => useIdleActs([member("a", "idle")], [seat(0)], 0, [28], { rng: () => 0.99 }));
    tick(IDLE_MS * 10);
    expect(result.current).toEqual({});
  });

  it("is never taken away from a robot that is working", () => {
    const { result } = run([member("a", "working"), member("b", "idle")]);
    tick(IDLE_MS + 2000);
    expect(result.current.a).toBeUndefined();
    expect(result.current.b).toBeDefined();
  });

  it("drops what it is doing and goes back to its desk when it gets work", () => {
    const { result, rerender } = run([member("a", "idle")]);
    for (let t = 0; t < 40_000; t += 250) {
      tick(250);
      if (result.current.a?.act) break;
    }
    expect(result.current.a?.act).toBe("pet");
    rerender({ crew: [member("a", "working")] });
    tick(30_000);
    expect(result.current).toEqual({});
    // And it does not get up again while it works.
    tick(IDLE_MS * 10);
    expect(result.current).toEqual({});
  });

  it("does not send two robots to the same spot", () => {
    const { result } = run([member("a", "idle"), member("b", "idle")]);
    for (let t = 0; t < 40_000; t += 250) {
      tick(250);
      if (result.current.a?.act && result.current.b?.act) break;
    }
    const spots = ["a", "b"].map((key) => `${result.current[key]?.x},${result.current[key]?.y}`);
    expect(new Set(spots).size).toBe(2);
    expect(ACT_MS.pet).toBeGreaterThan(0);
  });
});
