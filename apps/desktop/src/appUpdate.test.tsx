/**
 * ThingMaker's own updates: the startup popup only when asked for, the blue
 * dot on the button beside Chill, installing with progress, and a failed
 * install that leaves things as they were.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ check: vi.fn(), install: vi.fn() }));
vi.mock("./ipc", () => ({
  api: {
    appUpdateCheck: calls.check,
    appUpdateInstall: calls.install,
    prefSet: vi.fn(async () => undefined),
  },
}));

import { useStore } from "./store";
import { UpdateButton, UpdatePrompt } from "./components/AppUpdate";

const NEWER = { current: "0.1.0", available: { version: "0.2.0", notes: "Faster sends." } };
const EMPTY = { current: null, available: null, checking: false, checkedAt: null, error: null, installing: null, prompt: false };

beforeEach(() => {
  calls.check.mockReset();
  calls.install.mockReset();
  useStore.setState({ appUpdate: { ...EMPTY }, uiPrefs: { enterSends: true, reducedMotion: "system", transcriptPage: 50, followUp: "queue" }, sessions: {}, jobs: {} } as never);
});
afterEach(cleanup);

describe("checking", () => {
  it("raises the popup only at startup, and only with the reminder on", async () => {
    calls.check.mockResolvedValue(NEWER);
    await useStore.getState().checkForUpdate("timer");
    expect(useStore.getState().appUpdate.prompt).toBe(false);
    expect(useStore.getState().appUpdate.available?.version).toBe("0.2.0");
    await useStore.getState().checkForUpdate("startup");
    expect(useStore.getState().appUpdate.prompt).toBe(true);

    useStore.setState({ appUpdate: { ...EMPTY }, uiPrefs: { ...useStore.getState().uiPrefs, updateReminder: false } });
    await useStore.getState().checkForUpdate("startup");
    expect(useStore.getState().appUpdate.prompt).toBe(false);
    expect(useStore.getState().appUpdate.available?.version).toBe("0.2.0");
  });

  it("says quietly when it could not check", async () => {
    calls.check.mockRejectedValue({ code: "IO", message: "could not check for updates: offline", retry: "user_action" });
    await useStore.getState().checkForUpdate("startup");
    expect(useStore.getState().appUpdate).toMatchObject({ checking: false, error: "could not check for updates: offline", prompt: false, available: null });
  });
});

describe("the button beside Chill", () => {
  it("carries a blue dot only while an update is waiting, and installs it", async () => {
    calls.check.mockResolvedValue({ current: "0.1.0" });
    const { container, rerender } = render(<UpdateButton />);
    expect(container.querySelector(".update-dot")).toBeNull();
    useStore.setState({ appUpdate: { ...EMPTY, current: "0.1.0", available: NEWER.available } });
    rerender(<UpdateButton />);
    expect(container.querySelector(".update-dot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ThingMaker 0.2.0 is available" }));
    expect(screen.getByText("You have 0.1.0.")).toBeTruthy();
    expect(screen.getByText("Faster sends.")).toBeTruthy();
    calls.install.mockImplementation(async (onProgress: (progress: { downloaded: number; total?: number }) => void) => {
      onProgress({ downloaded: 5 * 1024 * 1024, total: 10 * 1024 * 1024 });
      await new Promise(() => undefined);
    });
    fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    expect(await screen.findByText("Downloading… 50%")).toBeTruthy();
  });

  it("warns that restarting stops sessions at work", () => {
    useStore.setState({
      appUpdate: { ...EMPTY, current: "0.1.0", available: NEWER.available },
      sessions: { s1: { projection: { foreground: "running" } } },
    } as never);
    render(<UpdateButton />);
    fireEvent.click(screen.getByRole("button", { name: "ThingMaker 0.2.0 is available" }));
    expect(screen.getByText("A session is working; restarting stops it.")).toBeTruthy();
  });
});

describe("the startup popup", () => {
  it("can wait for later, or stop reminding", () => {
    const setUiPrefs = vi.fn(async () => undefined);
    useStore.setState({ appUpdate: { ...EMPTY, current: "0.1.0", available: NEWER.available, prompt: true }, setUiPrefs } as never);
    const { container } = render(<UpdatePrompt />);
    expect(screen.getByRole("dialog", { name: "Update available" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(container.firstChild).toBeNull();
    expect(setUiPrefs).not.toHaveBeenCalled();

    cleanup();
    useStore.setState({ appUpdate: { ...useStore.getState().appUpdate, prompt: true } });
    render(<UpdatePrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Don't remind me at startup" }));
    expect(setUiPrefs).toHaveBeenCalledWith({ updateReminder: false });
  });
});

describe("installing", () => {
  it("leaves things as they were when the install fails, and checks again", async () => {
    useStore.setState({ appUpdate: { ...EMPTY, current: "0.1.0", available: NEWER.available } });
    calls.install.mockRejectedValue({ code: "IO", message: "the update could not be installed: bad signature", retry: "user_action" });
    calls.check.mockResolvedValue(NEWER);
    await useStore.getState().installUpdate();
    expect(useStore.getState().appUpdate.installing).toBeNull();
    expect(calls.check).toHaveBeenCalled();
  });
});
