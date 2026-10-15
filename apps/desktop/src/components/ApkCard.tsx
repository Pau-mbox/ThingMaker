/**
 * An Android app an agent built, as something to put on the phone: one
 * click sends it over the phone bridge, and Android on the phone asks to
 * confirm the install. On the phone itself the card offers to install it
 * there. Shown only when a phone could take it.
 */
import { useEffect, useState } from "react";
import { api } from "../ipc";
import { IS_REMOTE } from "../remote/mode";
import { IconArrowUp } from "./icons";

export function ApkCard({ path }: { path: string }) {
  const [phones, setPhones] = useState(IS_REMOTE ? 1 : 0);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (IS_REMOTE) return;
    api
      .remoteStatus()
      .then((status) => setPhones(status.enabled ? status.devices.filter((device) => device.connected).length : 0))
      .catch(() => setPhones(0));
  }, []);

  if (phones === 0) return null;
  const name = path.split("/").pop() ?? path;
  const send = async () => {
    setState("sending");
    try {
      await api.remoteSendApk(path);
      setState("sent");
      setMessage(IS_REMOTE ? "Android will ask you to confirm." : "Confirm the install on the phone.");
    } catch (error) {
      setState("failed");
      setMessage((error as { message?: string })?.message ?? String(error));
    }
  };
  return (
    <section className="doc-card apk-card">
      <header className="doc-card-head">
        <span className="mono">{name}</span>
        <span className="small muted doc-card-meta" title={path}>
          Android app
        </span>
        <span className="doc-actions">
          <button className="doc-action doc-action-bigthing" disabled={state === "sending"} onClick={() => void send()} type="button">
            <IconArrowUp size={13} /> {state === "sending" ? "Sending…" : IS_REMOTE ? "Install on this phone" : "Install on phone"}
          </button>
        </span>
      </header>
      {message && <p className={`small doc-card-more ${state === "failed" ? "chip-warn" : "muted"}`}>{message}</p>}
    </section>
  );
}

/** Paths to Android apps an agent's message names. */
export function apksNamedIn(text: string, root: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|[\s`(["'<])((?:~|\.{1,2})?\/?[\w@+\-./]*[\w-]\.apk)(?=$|[\s`)\]"'>,:;!?]|\.(?:\s|$))/gim)) {
    const raw = match[1] as string;
    if (raw.startsWith("~")) continue;
    const path = raw.startsWith("/") ? raw : `${root.replace(/\/$/, "")}/${raw.replace(/^\.\//, "")}`;
    if (!found.includes(path)) found.push(path);
  }
  return found.slice(0, 3);
}
