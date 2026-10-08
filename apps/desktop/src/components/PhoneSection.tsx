/**
 * Phone access, in Settings: turn the bridge on, pair a phone by scanning a
 * QR code, see which phones are connected, and revoke one.
 *
 * The phone reaches the Mac through the user's own relay — a Cloudflare
 * Worker behind Cloudflare Access — so this asks for the relay's address and
 * the Access service token, says whether the Mac is connected to it, and
 * rather than offering a code no phone could reach.
 */
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { REMOTE_EVENT, type RemoteStatus } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore } from "../store";

/** What the phone last said about an app it was sent. */
const OFFER_STATE: Record<string, string> = {
  sent: "sent — waiting for the phone",
  downloading: "downloading to the phone",
  confirm: "waiting for you to confirm on the phone",
  installed: "installed",
  failed: "not installed",
  cancelled: "cancelled on the phone",
};

function when(at: number | null): string {
  if (!at) return "never";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : new Date(at).toLocaleDateString();
}

const RELAY_STATE: Record<string, string> = {
  off: "not connected",
  connecting: "connecting…",
  connected: "connected",
  error: "can't connect",
};

/** The relay's address and the Access service token in front of it. */
function RelayForm({ status, onSaved }: { status: RemoteStatus; onSaved: () => void }) {
  const setError = useStore((s) => s.setError);
  const [url, setUrl] = useState(status.relay.url ?? "");
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [editing, setEditing] = useState(!status.relay.url);
  const save = () =>
    api
      .remoteSetRelay(url, id, secret)
      .then(() => {
        setId("");
        setSecret("");
        setEditing(false);
        onSaved();
      })
      .catch((error: unknown) => setError(error));
  const relay = status.relay;
  return (
    <div className="phone-relay">
      {relay.url && !editing ? (
        <p className="small">
          Relay <span className="mono">{relay.url}</span> ·{" "}
          <span className={relay.state === "connected" ? "" : relay.state === "error" ? "chip-warn" : "muted"}>{RELAY_STATE[relay.state] ?? relay.state}</span>
          {relay.access ? " · Cloudflare Access on" : " · no Access token set"}{" "}
          <button className="link small" onClick={() => setEditing(true)} type="button">
            change
          </button>
          {relay.message && <span className="small muted"> — {relay.message}</span>}
        </p>
      ) : (
        <form
          className="phone-relay-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="small muted">
            Deploy the relay once with <span className="mono">pnpm relay:deploy</span> (it asks you to sign in to Cloudflare), turn on Cloudflare Access in the
            Worker&rsquo;s Access tab with a service token, and paste the details here. The README has the steps.
          </p>
          <input aria-label="Relay address" className="input" onChange={(event) => setUrl(event.target.value)} placeholder="https://thingmaker-relay.you.workers.dev" value={url} />
          <input aria-label="Access client ID" className="input" onChange={(event) => setId(event.target.value)} placeholder={relay.access ? "Access client ID (saved)" : "Access client ID"} value={id} />
          <input
            aria-label="Access client secret"
            className="input"
            onChange={(event) => setSecret(event.target.value)}
            placeholder={relay.access ? "Access client secret (saved)" : "Access client secret"}
            type="password"
            value={secret}
          />
          <div className="row">
            <button className="button button-small button-primary" disabled={!url.trim()} type="submit">
              Save
            </button>
            {relay.url && (
              <button className="button button-small" onClick={() => setEditing(false)} type="button">
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

export function PhoneSection() {
  const setError = useStore((s) => s.setError);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(() => {
    api
      .remoteStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refresh();
    let stop: (() => void) | undefined;
    void listen(REMOTE_EVENT, refresh).then((fn) => {
      stop = fn;
    });
    return () => stop?.();
  }, [refresh]);

  // The QR's countdown, and a refresh when it runs out.
  const pairing = status?.pairing ?? null;
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() > pairing.expiresAt) refresh();
    }, 1000);
    return () => clearInterval(timer);
  }, [pairing, refresh]);

  const sendApk = async (device?: string) => {
    try {
      const path = await api.remotePickApk();
      if (path) await api.remoteSendApk(path, device);
      refresh();
    } catch (error) {
      setError(error);
    }
  };

  const run = (action: () => Promise<unknown>) => {
    action()
      .then(refresh)
      .catch((error: unknown) => setError(error));
  };

  if (!status) return null;
  const reachable = status.relay.state === "connected";
  const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;

  return (
    <section className="phone-section">
      <h3>Phone</h3>
      <p className="small muted">
        Follow and control this Mac&rsquo;s sessions and Big Things from the ThingMaker app on your Android phone. The phone reaches this Mac through your own relay on
        Cloudflare — the Mac only connects out, nothing listens here — behind Cloudflare Access, and each phone gets its own key, which you can revoke here. Sign-ins, provider settings, the terminal, git and file writes stay on
        the Mac.
      </p>
      <label className="check">
        <input checked={status.enabled} onChange={(event) => run(() => api.remoteSetEnabled(event.target.checked))} type="checkbox" /> Allow phone access
      </label>

      {status.enabled && (
        <>
          <RelayForm onSaved={refresh} status={status} />

          {pairing ? (
            <div className="phone-pairing">
              <div className="phone-qr" dangerouslySetInnerHTML={{ __html: pairing.qrSvg }} />
              <div>
                <p className="small">
                  In the ThingMaker app on your phone, tap <strong>Pair with a Mac</strong> and scan this code. Or type the code:
                </p>
                <p className="mono phone-code">{pairing.code.replace(/(.{5})/, "$1 ")}</p>
                <p className="small muted">
                  Good for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}, once.
                </p>
                <button className="button button-small" onClick={() => run(api.remotePairCancel)} type="button">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button className="button" disabled={!reachable} onClick={() => run(api.remotePairStart)} title={reachable ? undefined : "Connect the Mac to its relay first"} type="button">
              Pair a phone
            </button>
          )}

          {status.devices.length > 0 && (
            <ul className="phone-devices">
              {status.devices.map((device) => (
                <li key={device.id}>
                  <span className={`phone-dot ${device.connected ? "phone-dot-on" : ""}`} title={device.connected ? "Connected now" : "Not connected"} />
                  <strong>{device.name}</strong>
                  <span className="small muted">
                    {device.connected ? "connected" : `last seen ${when(device.lastSeen)}`} · paired {new Date(device.pairedAt).toLocaleDateString()}
                  </span>
                  {device.connected && (
                    <button className="link small" onClick={() => void sendApk(device.id)} title="Install an Android app on this phone: it asks you to confirm there" type="button">
                      Send an app…
                    </button>
                  )}
                  <button className="link small" onClick={() => run(() => api.remoteDeviceRevoke(device.id))} type="button">
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}

          {status.offers.length > 0 && (
            <ul className="phone-offers">
              {status.offers.map((offer) => (
                <li key={offer.id}>
                  <span className="mono">{offer.name}</span>
                  <span className={`small ${offer.state === "failed" ? "chip-warn" : "muted"}`}>
                    {OFFER_STATE[offer.state] ?? offer.state}
                    {offer.message ? ` — ${offer.message}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
