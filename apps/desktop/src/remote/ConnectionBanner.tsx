/**
 * On the phone: whether the Mac is there. Shown only when it is not —
 * connecting, gone (the page reconnects by itself), or refused because the
 * phone's pairing was revoked.
 */
import { useEffect, useState } from "react";
import { bridge, type ConnectionState } from "./bridge";

export function ConnectionBanner() {
  const [state, setState] = useState<{ state: ConnectionState; message?: string | undefined }>({ state: "connecting" });
  useEffect(() => bridge().watch((next, message) => setState({ state: next, message })), []);
  if (state.state === "open") return null;
  return (
    <div className={`banner remote-banner ${state.state === "denied" ? "banner-error" : "banner-busy"}`} role="status">
      {state.state === "denied" ? (state.message ?? "This phone is not paired with the Mac.") : state.state === "closed" ? "Lost the Mac — reconnecting…" : "Connecting to the Mac…"}
    </div>
  );
}
