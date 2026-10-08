/** Settings → Phone: the relay's address and the Access token, and the Mac's line to it. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls: { command: string; args: Record<string, unknown> }[] = [];
let relay: Record<string, unknown> = { url: null, state: "off", message: null, access: false };
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "remote_status" || command === "remote_set_relay")
      return { enabled: true, port: 47321, name: "Mac", relay, listening: [], devices: [], pairing: null, offers: [] };
    return null;
  }),
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { PhoneSection } from "./components/PhoneSection";

afterEach(() => {
  cleanup();
  calls.length = 0;
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("phone access through the relay", () => {
  it("asks for the relay and the Access token, and saves them", async () => {
    relay = { url: null, state: "off", message: null, access: false };
    render(<PhoneSection />);
    await settle();
    fireEvent.change(screen.getByLabelText("Relay address"), { target: { value: "thingmaker-relay.pau.workers.dev" } });
    fireEvent.change(screen.getByLabelText("Access client ID"), { target: { value: "id.access" } });
    fireEvent.change(screen.getByLabelText("Access client secret"), { target: { value: "s3cret" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(calls.find((call) => call.command === "remote_set_relay")?.args).toEqual({ url: "thingmaker-relay.pau.workers.dev", accessClientId: "id.access", accessClientSecret: "s3cret" });
    expect((screen.getByRole("button", { name: "Pair a phone" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says when the Mac is connected to its relay, and lets a phone pair", async () => {
    relay = { url: "https://thingmaker-relay.pau.workers.dev", state: "connected", message: null, access: true };
    render(<PhoneSection />);
    await settle();
    expect(screen.getByText("connected")).toBeTruthy();
    expect(screen.getByText(/Cloudflare Access on/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Pair a phone" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
