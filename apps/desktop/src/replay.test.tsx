/**
 * Replays a real recorded Kit turn (kit 0.1.129, prompt "Hey") through the
 * projection and the actual React components. This is the regression test
 * for the blank-window defect: a snake_case field in one event made the
 * composer footer throw during render.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope, Snapshot } from "@thingmaker/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("invoke is not available in tests");
  }),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => "denied"),
  sendNotification: vi.fn(),
}));

import { EMPTY_SESSION_USAGE, useStore, type LiveSession } from "./store";
import { applyEvent, emptyProjection } from "./projection";
import { SessionPanel } from "./components/SessionPanel";
import { Sidebar } from "./components/Sidebar";
import { AttentionBanner } from "./components/Attention";

const here = dirname(fileURLToPath(import.meta.url));
const events: EventEnvelope[] = readFileSync(resolve(here, "__fixtures__/events-hey.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as EventEnvelope);
const attach = JSON.parse(readFileSync(resolve(here, "__fixtures__/attach-real.json"), "utf8")) as {
  configOptions: unknown;
  availableCommands: { name: string; description?: string }[];
  agentSessionId: string;
};

function seedSession(): LiveSession {
  const handle = events[0]!.session;
  const snapshot: Snapshot = {
    handle,
    provider: "codex",
    agentSessionId: attach.agentSessionId,
    historyStart: "1",
    historyDropped: 0,
    process: "ready",
    attachment: "attached",
    capabilities: null,
    foreground: "idle",
    autonomousTurns: [],
    detachedCalls: {},
    toolCalls: {},
    configOptions: attach.configOptions,
    availableCommands: attach.availableCommands,
    pendingSteers: [],
    lastSequence: "8",
    exit: null,
  };
  const projection = emptyProjection();
  projection.process = "ready";
  projection.attachment = "attached";
  return { handle, workspaceId: "w1", snapshot, projection, inFlightRequestId: null, steerInFlight: false, attention: "none", openedAt: 0, turnStartedAt: null, lastEventAt: null, usage: EMPTY_SESSION_USAGE };
}

describe("real turn replay", () => {
  beforeEach(() => {
    const session = seedSession();
    useStore.setState({
      sessions: { [session.handle.id]: session },
      sessionOrder: [session.handle.id],
      view: { kind: "session", sessionId: session.handle.id },
      workspaces: [
        { id: "w1", environmentId: "local", canonicalRoot: "/p", displayPath: "/p", workspaceHash: "w-1", trustState: "trusted_local", createdAt: 0 },
      ],
    });
  });
  afterEach(() => useStore.setState({ sessions: {}, sessionOrder: [], view: { kind: "welcome" } }));

  it("uses camelCase event fields", () => {
    const submission = events.find((e) => e.payload.type === "submission");
    expect(submission && "requestId" in submission.payload).toBe(true);
    const settled = events.find((e) => e.payload.type === "turn" && e.payload.effect === "settled");
    expect(settled && "stopReason" in settled.payload).toBe(true);
  });

  it("renders the session panel, sidebar and banner after every event without throwing", () => {
    const id = events[0]!.session.id;
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    for (const event of events) {
      const current = useStore.getState().sessions[id]!;
      const projection = applyEvent(current.projection, event);
      useStore.setState({ sessions: { [id]: { ...current, projection: { ...projection } } } });
      const view = render(
        <>
          <AttentionBanner />
          <Sidebar />
          <SessionPanel sessionId={id} />
        </>,
      );
      view.unmount();
    }
    spy.mockRestore();
    expect(errors.filter((e) => String(e).includes("Error")).length).toBe(0);
    render(<SessionPanel sessionId={id} />);
    expect(screen.getByText(/Hey! How can I help\?/)).toBeTruthy();
    expect(screen.getByText(/last submission harness-: accepted/)).toBeTruthy();
    expect(screen.getByText(/model: gpt-5.6-sol · OpenAI subscription/)).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Default" })).toBeTruthy();
    expect(useStore.getState().sessions[id]!.projection.foreground).toBe("succeeded");
  });
});
