import { describe, expect, it } from "vitest";
import { COMMANDS, PROVIDERS, PROVIDER_LABELS } from "../src/index";

describe("contracts", () => {
  it("names every command once", () => {
    const names = Object.values(COMMANDS);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => /^[a-z_]+$/.test(name))).toBe(true);
  });

  it("labels every provider", () => {
    expect(PROVIDERS).toEqual(["claude", "codex"]);
    for (const provider of PROVIDERS) expect(PROVIDER_LABELS[provider]).toBeTruthy();
  });
});
