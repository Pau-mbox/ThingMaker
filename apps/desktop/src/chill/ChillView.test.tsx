import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivitySnapshot, WorkspaceRecord } from "@thingmaker/contracts";
import type { ChillRenderer } from "./skins/types";
const resources = vi.hoisted(() => ({
  scenes: [] as {
    update: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }[],
  audio: { stop: vi.fn(), suspend: vi.fn(), setVolume: vi.fn() },
  fail: false,
}));
vi.mock("../ipc", () => ({
  api: {
    prefGet: vi.fn(async () => null),
    prefSet: vi.fn(async () => undefined),
    activitySnapshot: vi.fn(),
    activityClear: vi.fn(async () => undefined),
    sessionListOpen: vi.fn(async () => []),
  },
}));
vi.mock("./skins/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./skins/registry")>();
  const createRenderer = async (host: HTMLElement): Promise<ChillRenderer> => {
    if (resources.fail) throw new Error("WebGL unavailable");
    const canvas = document.createElement("canvas");
    host.appendChild(canvas);
    const scene = { update: vi.fn(), destroy: vi.fn(() => canvas.remove()) };
    resources.scenes.push(scene);
    return scene;
  };
  const first = {
    ...actual.SKINS[0]!,
    createRenderer,
    createAudio: () => resources.audio,
  };
  // A test double proves replaceability. This is never a production skin.
  const second = { ...first, id: "test-only", label: "Test skin" };
  return {
    ...actual,
    SKINS: [first, second],
    resolveSkin: (id: unknown) => (id === "test-only" ? second : first),
  };
});
import ChillView from "./ChillView";
import { api } from "../ipc";
import { useStore } from "../store";
const now = Date.now();
const workspaces: WorkspaceRecord[] = [
  {
    id: "w",
    environmentId: "local",
    canonicalRoot: "/repo",
    displayPath: "/repo",
    workspaceHash: "w",
    trustState: "trusted_local",
    createdAt: now,
  },
];
const snapshot: ActivitySnapshot = {
  revision: "1",
  observedAt: now,
  jobs: [],
  goals: [],
  files: [],
  actors: [
    {
      id: "s",
      sessionId: "s",
      workspaceId: "w",
      parentId: null,
      name: "Keeper",
      provider: "claude",
      model: null,
      status: "working",
      task: "Build the project",
      operation: "build",
      fileId: null,
      lastSeen: now,
      native: false,
      generation: "1",
    },
  ],
};
const preview = { snapshot, workspaces };
beforeEach(() => {
  vi.clearAllMocks();
  resources.scenes.length = 0;
  resources.fail = false;
  useStore.setState({ paletteOpen: false });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});
afterEach(cleanup);
describe("shared Chill controller", () => {
  it("preserves activity, selection and focus across a skin change and disposes rendering/audio", async () => {
    const exit = vi.fn();
    const view = render(<ChillView onExit={exit} preview={preview} />);
    await waitFor(() => expect(resources.scenes.length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: /Keeper, claude/ }));
    fireEvent.click(screen.getByRole("button", { name: "Enable ambience" }));
    fireEvent.click(screen.getByRole("button", { name: /Change skin/ }));
    await waitFor(() => expect(resources.scenes[1]?.update).toHaveBeenCalled());
    expect(resources.scenes[0]!.destroy).toHaveBeenCalledOnce();
    expect(resources.audio.stop).toHaveBeenCalledOnce();
    const update = resources.scenes[1]!.update.mock.lastCall!;
    expect(update[0][0].actors[0].id).toBe("s");
    expect(update[1].selection).toEqual({ kind: "actor", id: "s" });
    expect(update[1].focus).toBe("w");
    expect(document.querySelectorAll("canvas")).toHaveLength(1);
    expect(document.body.textContent).toBe("");
    expect(exit).not.toHaveBeenCalled();
    view.unmount();
    expect(resources.scenes[1]!.destroy).toHaveBeenCalledOnce();
    expect(document.querySelectorAll("canvas")).toHaveLength(0);
  });
  it("returns to overview before Escape leaves Chill, without adding visible text", async () => {
    const exit = vi.fn();
    render(<ChillView onExit={exit} preview={preview} />);
    await waitFor(() => expect(resources.scenes.length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: /Focus project/ }));
    expect(screen.getByRole("button", { name: "Whole scene" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Whole scene" })).toBeNull();
    expect(exit).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(exit).toHaveBeenCalledOnce();
  });
  it("keeps accessible inspection and source navigation available in a text-free graphics fallback", async () => {
    resources.fail = true;
    render(<ChillView onExit={() => undefined} preview={preview} />);
    await waitFor(() =>
      expect(document.querySelector(".chill-still")).toBeTruthy(),
    );
    const inspection = screen.getByLabelText("Activity inspection");
    fireEvent.click(
      within(inspection).getByRole("button", { name: /Keeper, claude/ }),
    );
    expect(
      screen.getByRole("button", { name: "Open selected work" }),
    ).toBeTruthy();
    expect(document.body.textContent).toBe("");
  });
  it("persists a safe fallback ID and applies reduced motion without changing activity", async () => {
    vi.mocked(api.prefGet).mockResolvedValueOnce({
      skinId: "missing",
      sound: true,
    });
    useStore.setState({
      uiPrefs: { ...useStore.getState().uiPrefs, reducedMotion: "reduce" },
    });
    render(<ChillView onExit={() => undefined} preview={preview} />);
    await waitFor(() => expect(resources.scenes[0]?.update).toHaveBeenCalled());
    expect(resources.scenes[0]!.update.mock.lastCall![1].reduced).toBe(true);
    expect(
      resources.scenes[0]!.update.mock.lastCall![0][0].actors[0].status,
    ).toBe("working");
    expect(document.body.textContent).toBe("");
    await waitFor(() =>
      expect(api.prefSet).toHaveBeenCalledWith(
        "chill_preferences",
        expect.objectContaining({ skinId: "terrarium", sound: false }),
      ),
    );
  });
  it("shows only project names when several plants are visible, and hides names in focus", async () => {
    resources.fail = true;
    const multiple = {
      snapshot,
      workspaces: [
        ...workspaces,
        {
          ...workspaces[0]!,
          id: "other",
          canonicalRoot: "/garden",
          displayPath: "/garden",
        },
      ],
    };
    render(<ChillView onExit={() => undefined} preview={multiple} />);
    await waitFor(() =>
      expect(document.querySelector(".chill-still")).toBeTruthy(),
    );
    expect(document.body.textContent).toBe("repogarden");
    const plants = document.querySelector(
      ".terrarium-still-plants",
    ) as HTMLElement;
    fireEvent.click(
      within(plants).getByRole("button", { name: "Focus project repo" }),
    );
    expect(document.body.textContent).toBe("");
    expect(
      within(plants).queryByRole("button", { name: "Focus project garden" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Whole scene" }));
    expect(document.body.textContent).toBe("repogarden");
  });
});
