import { describe, expect, it } from "vitest";
import { CHATTER, chatterGap, chatterLine } from "./chatter";

describe("helper chatter", () => {
  it("keeps every line to four words at most", () => {
    for (const lines of Object.values(CHATTER))
      for (const line of lines) expect(line.split(/\s+/).filter(Boolean).length, line).toBeLessThanOrEqual(4);
  });

  it("speaks now and then, not continuously, and varies what it says", () => {
    for (let count = 1; count < 20; count++) expect(chatterGap(5, count)).toBeGreaterThanOrEqual(15);
    const said = new Set(Array.from({ length: 12 }, (_, count) => chatterLine("editing", 5, count)));
    expect(said.size).toBeGreaterThan(3);
  });
});
