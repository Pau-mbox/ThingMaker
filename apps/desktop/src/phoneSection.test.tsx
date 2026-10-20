/** Settings → Phone: how the phone reaches this computer (relay or direct), and the details of that way. */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls: { command: string; args: Record<string, unknown> }[] = [];
let relay: Record<string, unknown> = { url: null, state: "off", message: null, access: false };
let extra: Record<string, unknown> = { mode: "relay", directUrl: null, listening: [] };
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "remote_status" || command === "remote_set_connection")
      return { enabled: true, port: 47321, name: "Mac", relay, devices: [], pairing: null, offers: [], ...extra };
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

const pairButton = () => screen.getByRole("button", { name: "Pair a phone" }) as HTMLButtonElement;

describe("how the phone reaches this computer", () => {
  it("asks for the relay and the Access token, and saves them", async () => {
    relay = { url: null, state: "off", message: null, access: false };
    extra = { mode: "relay", directUrl: null, listening: [] };
    render(<PhoneSection />);
    await settle();
    fireEvent.change(screen.getByLabelText("Relay address"), { target: { value: "thingmaker-relay.pau.workers.dev" } });
    fireEvent.change(screen.getByLabelText("Access client ID"), { target: { value: "id.access" } });
    fireEvent.change(screen.getByLabelText("Access client secret"), { target: { value: "s3cret" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(calls.find((call) => call.command === "remote_set_connection")?.args).toEqual({ mode: "relay", url: "thingmaker-relay.pau.workers.dev", accessClientId: "id.access", accessClientSecret: "s3cret" });
    expect(pairButton().disabled).toBe(true);
  });

  it("says when the computer is connected to its relay, and lets a phone pair", async () => {
    relay = { url: "https://thingmaker-relay.pau.workers.dev", state: "connected", message: null, access: true };
    extra = { mode: "relay", directUrl: null, listening: [] };
    render(<PhoneSection />);
    await settle();
    expect(screen.getByText("connected")).toBeTruthy();
    expect(screen.getByText(/Cloudflare Access on/)).toBeTruthy();
    expect(pairButton().disabled).toBe(false);
  });

  it("saves a tunnel's address in the direct mode, with the port it forwards to", async () => {
    relay = { url: "https://thingmaker-relay.pau.workers.dev", state: "off", message: null, access: false };
    extra = { mode: "relay", directUrl: null, listening: [] };
    render(<PhoneSection />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "change" }));
    fireEvent.click(screen.getByRole("radio", { name: "Direct, through my own tunnel" }));
    expect(screen.getByText(/cloudflared tunnel --url http:\/\/127.0.0.1:47321/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Tunnel address"), { target: { value: "https://thingmaker.example.com" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(calls.find((call) => call.command === "remote_set_connection")?.args).toMatchObject({ mode: "direct", url: "https://thingmaker.example.com" });
  });

  it("lets a phone pair in the direct mode once the port listens", async () => {
    relay = { url: null, state: "off", message: null, access: false };
    extra = { mode: "direct", directUrl: "https://thingmaker.example.com", listening: ["127.0.0.1:47321"] };
    render(<PhoneSection />);
    await settle();
    expect(screen.getByText(/forwarded to 127.0.0.1:47321/)).toBeTruthy();
    expect(pairButton().disabled).toBe(false);
  });

  it("opens a step-by-step guide beside each way in", async () => {
    relay = { url: null, state: "off", message: null, access: false };
    extra = { mode: "relay", directUrl: null, listening: [] };
    render(<PhoneSection />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "How to set up: Through my Cloudflare relay" }));
    const relayGuide = within(screen.getByRole("dialog", { name: "Phone setup guide" }));
    expect(relayGuide.getByText("pnpm relay:deploy")).toBeTruthy();
    expect(relayGuide.getByText("Create a service token")).toBeTruthy();
    fireEvent.click(relayGuide.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("dialog", { name: "Phone setup guide" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "How to set up: Direct, through my own tunnel" }));
    const directGuide = within(screen.getByRole("dialog", { name: "Phone setup guide" }));
    expect(directGuide.getByText("cloudflared tunnel --url http://127.0.0.1:47321")).toBeTruthy();
    expect(directGuide.getByText("tailscale funnel 47321")).toBeTruthy();
  });
});
