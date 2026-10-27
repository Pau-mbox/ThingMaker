/**
 * The office puts the crew where the work is: a robot on a job at its desk,
 * the rest in the lounge, the lead always at the head desk.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OfficeScene, layoutFor, placeCrew } from "./components/OfficeScene";
import type { CrewMember } from "./components/crew";

const member = (key: string, state: CrewMember["state"], role: CrewMember["role"] = "coder"): CrewMember => ({ key, provider: "claude", role, name: key, state, status: state, title: `${key} task`, kind: role === "lead" ? "lead" : "helper", model: null, task: `${key} task` });

afterEach(cleanup);

describe("placeCrew", () => {
  it("seats the lead at the head desk and every helper at a desk of its own, whatever it is doing", () => {
    const places = placeCrew([member("lead", "idle", "lead"), member("a", "working"), member("b", "idle"), member("c", "done")]);
    const desks = places.map((place) => `${place.desk.x},${place.desk.y}`);
    expect(new Set(desks).size).toBe(4);
    // The helpers' desks are below the lead's.
    expect(places[1]!.y).toBeGreaterThan(places[0]!.y);
    expect(places.every((place) => place.y === place.desk.y - 8)).toBe(true);
  });
});

describe("layoutFor", () => {
  it("makes the room as big as the team: a row of desks for every three helpers", () => {
    expect(layoutFor(0).rows).toBe(0);
    expect(layoutFor(1)).toMatchObject({ rows: 1, columns: 1, xs: [80] });
    expect(layoutFor(2)).toMatchObject({ rows: 1, columns: 2 });
    expect(layoutFor(4)).toMatchObject({ rows: 2, columns: 3 });
    expect(layoutFor(9).h).toBe(290);
    expect(layoutFor(3).h).toBeLessThan(layoutFor(6).h);
  });

  it("gives every helper its own desk, however many", () => {
    const crew = [member("lead", "idle", "lead"), ...Array.from({ length: 11 }, (_, i) => member(`h${i}`, "working"))];
    const desks = placeCrew(crew).slice(1).map((place) => `${place.desk.x},${place.desk.y}`);
    expect(new Set(desks).size).toBe(11);
  });
});

describe("OfficeScene", () => {
  it("says how many of the crew are at work", () => {
    render(<OfficeScene crew={[member("lead", "working", "lead"), member("a", "working"), member("b", "idle")]} />);
    expect(screen.getByRole("img", { name: "The crew's office: 2 of 3 at work" })).toBeTruthy();
    expect(screen.getByText("a task")).toBeTruthy();
  });

  it("draws no logo of its own, and draws a person's images on the wall screen and in the frame", () => {
    const crew = [member("lead", "working", "lead")];
    const plain = render(<OfficeScene crew={crew} />);
    expect(plain.container.querySelectorAll("image")).toHaveLength(0);
    plain.unmount();
    const custom = render(<OfficeScene crew={crew} logo="data:image/png;base64,AAAA" wall="data:image/png;base64,BBBB" />);
    const hrefs = [...custom.container.querySelectorAll("image")].map((node) => node.getAttribute("href"));
    expect(hrefs).toEqual(["data:image/png;base64,BBBB", "data:image/png;base64,AAAA"]);
  });
});
