/**
 * On the phone: whether the computer is there. Shown only when it is not —
 * connecting, gone (the page reconnects by itself), or refused because the
 * phone's pairing was revoked.
 */
import { useEffect, useState } from "react";
import { bridge, type ConnectionState } from "./bridge";
import { t } from "../i18n";

export function ConnectionBanner() {
  const [state, setState] = useState<{ state: ConnectionState; message?: string | undefined }>({ state: "connecting" });
  useEffect(() => bridge().watch((next, message) => setState({ state: next, message })), []);
  if (state.state === "open") return null;
  return (
    <div className={`banner remote-banner ${state.state === "denied" ? "banner-error" : "banner-busy"}`} role="status">
      {state.state === "denied"
        ? (state.message ?? t("This phone is not paired with the computer."))
        : (state.message ?? (state.state === "closed" ? t("Lost the computer — reconnecting…") : t("Connecting to the computer…")))}
    </div>
  );
}
