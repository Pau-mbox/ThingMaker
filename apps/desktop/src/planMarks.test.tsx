/**
 * The plan's marks: a step to do, the step the agent is on — turning only
 * while its turn runs — and a done step.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { PlanContent } from "@thingmaker/contracts";
import { PlanBar, PlanCard } from "./components/PlanChecklist";

afterEach(cleanup);

const plan = {
  id: "p",
  planType: "items",
  entries: [
    { content: "Set up workspace", status: "completed" },
    { content: "Running the build", status: "in_progress" },
    { content: "Draft the PR", status: "pending" },
  ],
} as unknown as PlanContent;

const item = (container: HTMLElement, text: string) => Array.from(container.querySelectorAll("li")).find((li) => li.textContent?.includes(text)) as HTMLElement;

it("turns the current step only while the turn runs", () => {
  const live = render(<PlanCard live plan={plan} />);
  expect(item(live.container, "Running the build").querySelector(".plan-mark-live")).toBeTruthy();
  expect(item(live.container, "Draft the PR").querySelector(".plan-mark-live")).toBeNull();
  expect(item(live.container, "Set up workspace").querySelector(".plan-mark-completed .plan-mark-tick")).toBeTruthy();
  expect(item(live.container, "Draft the PR").querySelector(".plan-mark-pending .plan-mark-dots")).toBeTruthy();
  cleanup();
  const settled = render(<PlanCard plan={plan} />);
  expect(settled.container.querySelector(".plan-mark-live")).toBeNull();
});

it("shows the turning mark beside the current step in the bar", () => {
  const { container } = render(<PlanBar active plan={plan} />);
  expect(container.querySelector(".plan-bar-row .plan-mark-live")).toBeTruthy();
  expect(container.textContent).toContain("Running the build");
});
