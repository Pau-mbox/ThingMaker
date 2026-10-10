/** The sidebar's account usage: a session's bare "allowed" must not erase a measured reading. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { useStore } from "./store";

const measured = { provider: "claude" as const, status: "allowed" as const, observedAtUnixMs: 1, windows: [{ kind: "five_hour", usedPercent: 38, windowMinutes: 300 }] };
const bare = { provider: "claude" as const, status: "allowed" as const, observedAtUnixMs: 2, windows: [] };

describe("account usage readings", () => {
  it("keeps a measured reading when a session reports only that it is allowed", () => {
    useStore.setState({ usage: {} });
    useStore.getState().noteQuota(measured);
    useStore.getState().noteQuota(bare);
    expect(useStore.getState().usage.claude?.primary?.usedPercent).toBe(38);
  });

  it("clears a refusal once a turn is allowed again", () => {
    useStore.setState({ usage: {} });
    useStore.getState().noteQuota({ ...bare, status: "rejected", windows: [{ kind: "five_hour", resetsAt: 9 }] });
    expect(useStore.getState().usage.claude?.limitReached).toBe(true);
    useStore.getState().noteQuota(bare);
    expect(useStore.getState().usage.claude).toBeNull();
  });
});
