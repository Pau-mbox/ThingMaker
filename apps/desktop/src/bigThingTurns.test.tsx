/**
 * Big Thing runs a goal through the session's own turns. These check that its
 * prompts are recognised — live by their submission id, replayed by the lines
 * the engine writes — that they render as Big Thing's and not "You", and that
 * the conversation and the board link to each other.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OdysseyView } from "@thingmaker/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("invoke is not available in tests");
  }),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }) }));

import { bigThingTurnOf, milestoneTurnKey } from "./bigThingTurns";
import type { Card } from "./projection";
import { useStore } from "./store";
import { BigThingBand, BigThingTurnCard } from "./components/BigThingLinks";

const initial = useStore.getState();
afterEach(() => {
  cleanup();
  useStore.setState(initial, true);
});

function userCard(messageId: string, text: string): Extract<Card, { kind: "message" }> {
  const key = `user|${messageId}`;
  return { kind: "message", key, message: { key, role: "user", messageId, blocks: [{ type: "text", text }], contentUnknown: false } };
}

describe("recognising Big Thing's prompts", () => {
  it("reads a continuation's milestone from its first line", () => {
    expect(bigThingTurnOf("anything", "Continue. Milestone 3/7: Build onboarding screens.\nSpec: …")).toEqual({
      kind: "continuation",
      milestone: 3,
      total: 7,
      title: "Build onboarding screens",
    });
  });

  it("knows the briefing and the planning prompt in replayed history", () => {
    expect(bigThingTurnOf("provider-id", "You are working under Big Thing, ThingMaker's long-horizon runner.\n\n…")).toEqual({ kind: "briefing" });
    expect(bigThingTurnOf("provider-id", "You are setting up a Big Thing goal, ThingMaker's long-horizon runner.")).toEqual({ kind: "planning" });
  });

  it("trusts the submission id when the text is unfamiliar", () => {
    expect(bigThingTurnOf("prompt-bigthing-abc", "Something new")).toEqual({ kind: "other" });
    expect(bigThingTurnOf("prompt-bigthing-plan-abc", "Something new")).toEqual({ kind: "planning" });
  });

  it("leaves the user's own messages alone", () => {
    expect(bigThingTurnOf("prompt-req-1", "Continue with the next thing please")).toBeNull();
    expect(bigThingTurnOf("prompt-req-2", "What is Big Thing doing?")).toBeNull();
  });

  it("finds a milestone's latest turn by title, then by position", () => {
    const cards: Card[] = [
      userCard("a", "Continue. Milestone 2/3: Old name."),
      userCard("b", "Continue. Milestone 1/3: Audit."),
      userCard("c", "Continue. Milestone 2/3: Old name."),
      userCard("d", "hello"),
    ];
    expect(milestoneTurnKey(cards, 1, "Old name")).toBe("user|c");
    expect(milestoneTurnKey(cards, 1, "Renamed since")).toBe("user|c");
    expect(milestoneTurnKey(cards, 2, "Never sent")).toBeNull();
  });
});

describe("the conversation says what Big Thing sent", () => {
  it("marks the turn as Big Thing's and opens the board at its milestone", () => {
    const card = userCard("prompt-bigthing-1", "Continue. Milestone 2/5: Define acceptance tests.");
    render(<BigThingTurnCard card={card} sessionId="s1" text="Continue. Milestone 2/5: Define acceptance tests." turn={{ kind: "continuation", milestone: 2, total: 5, title: "Define acceptance tests" }} />);
    expect(screen.getByText("Big Thing → milestone 2/5: Define acceptance tests")).toBeTruthy();
    expect(screen.queryByText("You")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open in Big Thing" }));
    expect(useStore.getState().sessionTab).toBe("odyssey");
    expect(useStore.getState().odysseyFocus).toEqual({ sessionId: "s1", milestone: 1 });
  });

  it("says above the conversation that Big Thing is driving it", () => {
    const view = {
      goal: { id: "o1", title: "Ship onboarding v2", state: "running" },
      milestones: [{ id: "m1", state: "verified" }, { id: "m2", state: "active" }],
      journal: [],
    } as unknown as OdysseyView;
    useStore.setState({ odyssey: { s1: view } });
    render(<BigThingBand sessionId="s1" />);
    expect(screen.getByText("Big Thing is driving this conversation")).toBeTruthy();
    expect(screen.getByText(/1\/2 verified/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Big Thing" }));
    expect(useStore.getState().sessionTab).toBe("odyssey");
  });

  it("shows nothing for a goal that has not started", () => {
    useStore.setState({ odyssey: { s1: { goal: { state: "draft" }, milestones: [], journal: [] } as unknown as OdysseyView } });
    const { container } = render(<BigThingBand sessionId="s1" />);
    expect(container.textContent).toBe("");
  });
});
