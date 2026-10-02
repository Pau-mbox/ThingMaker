/**
 * How an amendment reads on screen. The rule this protects: the status says
 * what actually happened to it, including when the agent has given up.
 */
import { describe, expect, it } from "vitest";
import { MAX_TELLS, amendmentStatus } from "./odysseyAmend";

describe("an amendment's status", () => {
  it("says on screen what actually happened to it", () => {
    expect(amendmentStatus({ state: "pending", tellCount: 0 })).toBe("queued for the next prompt");
    expect(amendmentStatus({ state: "told", tellCount: 1 })).toBe("with the agent");
    expect(amendmentStatus({ state: "told", tellCount: 2 })).toContain("told 2 times");
    // The give-up state has to read as the user's problem now, not the agent's.
    expect(amendmentStatus({ state: "told", tellCount: MAX_TELLS })).toContain("it is yours now");
    expect(amendmentStatus({ state: "applied", tellCount: 2 })).toBe("folded into the plan");
  });

  it("reads as delivered once a note to the agent is told", () => {
    expect(amendmentStatus({ state: "applied", tellCount: 1, kind: "note" })).toBe("delivered");
  });
});
