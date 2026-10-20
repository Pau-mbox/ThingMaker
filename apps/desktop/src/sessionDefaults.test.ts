/**
 * Where a new session starts: Claude when it can run, and the model and
 * effort last chosen on each provider, remembered separately.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({ api: {} }));
import { readSessionDefaults, startingProvider } from "./store";

const info = (provider: string, resolved = true, loggedIn = true) => ({ provider, label: provider, resolved: resolved ? { program: provider } : null, auth: { loggedIn } });

describe("new sessions", () => {
  it("start on Claude when it is installed and signed in, whatever was used last", () => {
    expect(startingProvider([info("claude"), info("codex"), info("gemini")] as never)).toBe("claude");
    expect(startingProvider(null)).toBe("claude");
  });

  it("start on the next provider that can run when Claude cannot", () => {
    expect(startingProvider([info("claude", true, false), info("codex"), info("gemini")] as never)).toBe("codex");
    expect(startingProvider([info("claude", false), info("codex", false), info("gemini")] as never)).toBe("gemini");
  });

  it("read the earlier single default as a choice for its provider only", () => {
    expect(readSessionDefaults({ provider: "codex", reasoningEffort: "high" })).toEqual({ codex: { reasoningEffort: "high" } });
    expect(readSessionDefaults({ claude: { model: "sonnet" }, codex: { model: "gpt-6", reasoningEffort: "low" } })).toEqual({
      claude: { model: "sonnet" },
      codex: { model: "gpt-6", reasoningEffort: "low" },
    });
    expect(readSessionDefaults(null)).toEqual({});
  });
});
