/**
 * The whiteboard: rolls into the lounge while the lead has a plan of steps,
 * with the steps on it, and rolls away once they are done and the turn is over.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContent } from "@thingmaker/contracts";
import { OfficeScene } from "./components/OfficeScene";
import { boardPlan, boardWindow } from "./components/OfficeBoard";
import type { CrewMember } from "./components/crew";

afterEach(cleanup);

const plan = (...statuses: string[]): Extract<PlanContent, { planType: "items" }> => ({ planType: "items", id: "p", entries: statuses.map((status, i) => ({ content: `Step ${i + 1}`, status })) }) as never;
const lead: CrewMember = { key: "lead", provider: "claude", role: "lead", name: "Lead", state: "working", status: "thinking", title: "", kind: "lead", model: null, task: "" };

describe("boardPlan", () => {
  it("is out while steps remain, or while the turn that finished them runs", () => {
    expect(boardPlan(plan("completed", "in_progress"), false)).not.toBeNull();
    expect(boardPlan(plan("completed", "completed"), true)).not.toBeNull();
    expect(boardPlan(plan("completed", "completed"), false)).toBeNull();
  });

  it("is not out for an empty plan, or a plan that is not a list of steps", () => {
    expect(boardPlan(plan(), true)).toBeNull();
    expect(boardPlan({ planType: "markdown", content: "# plan" } as never, true)).toBeNull();
    expect(boardPlan(null, true)).toBeNull();
  });
});

describe("boardWindow", () => {
  it("shows every step when they fit", () => {
    expect(boardWindow(plan("completed", "pending").entries)).toMatchObject({ start: 0, above: 0, below: 0 });
  });

  it("shows the stretch from the step before the current one when they do not", () => {
    const entries = plan("completed", "completed", "completed", "completed", "in_progress", "pending", "pending", "pending", "pending").entries;
    const { start, shown, above, below } = boardWindow(entries, 5);
    expect(start).toBe(3);
    expect(shown.map((entry) => entry.content)).toEqual(["Step 4", "Step 5", "Step 6", "Step 7", "Step 8"]);
    expect([above, below]).toEqual([3, 1]);
  });

  it("keeps the last stretch when everything is done", () => {
    const entries = plan(...Array(8).fill("completed")).entries;
    expect(boardWindow(entries, 5)).toMatchObject({ start: 3, above: 3, below: 0 });
  });
});

describe("the whiteboard in the office", () => {
  it("writes the plan on a board in the lounge, the current step marked", () => {
    render(<OfficeScene crew={[lead]} plan={plan("completed", "in_progress", "pending")} />);
    expect(screen.getByRole("img", { name: "Whiteboard: 1 of 3 steps done" })).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(screen.getByText("Step 2").closest("li")?.className).toContain("office-board-in_progress");
  });

  it("is not there without a plan", () => {
    render(<OfficeScene crew={[lead]} />);
    expect(screen.queryByRole("img", { name: /Whiteboard/ })).toBeNull();
  });
});
