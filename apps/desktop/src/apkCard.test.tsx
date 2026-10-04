/** An Android app an agent built: one click puts it on the paired phone. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls: { command: string; args: Record<string, unknown> }[] = [];
let connected = 1;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "remote_status") return { enabled: true, port: 1, name: "Mac", tailscale: [], listening: [], pairing: null, offers: [], devices: [{ id: "d1", name: "Pixel", pairedAt: 0, lastSeen: null, connected: connected > 0 }] };
    if (command === "remote_send_apk") return { id: "o1", name: "game.apk", size: 1, sha256: "x", device: null, offeredAt: 0, expiresAt: 0, state: "sent", message: null };
    return null;
  }),
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { ApkCard, apksNamedIn } from "./components/ApkCard";

afterEach(() => {
  cleanup();
  calls.length = 0;
  connected = 1;
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("an app an agent built", () => {
  it("is found in the message, absolute or under the project", () => {
    expect(apksNamedIn("Built `Builds/Android/game.apk` and /tmp/out/other.apk. See https://x.y/z.apk too.", "/w/app")).toEqual([
      "/w/app/Builds/Android/game.apk",
      "/tmp/out/other.apk",
    ]);
  });

  it("goes to the phone in one click", async () => {
    render(<ApkCard path="/w/app/game.apk" />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Install on phone/ }));
    await settle();
    expect(calls.find((call) => call.command === "remote_send_apk")?.args).toEqual({ path: "/w/app/game.apk", device: null });
    expect(screen.getByText(/Confirm the install on the phone/)).toBeTruthy();
  });

  it("is not offered when no phone is connected", async () => {
    connected = 0;
    const { container } = render(<ApkCard path="/w/app/game.apk" />);
    await settle();
    expect(container.firstChild).toBeNull();
  });
});
