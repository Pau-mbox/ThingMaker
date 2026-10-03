/**
 * Phone access, in Settings: turn the bridge on, pair a phone by scanning a
 * QR code, see which phones are connected, and revoke one.
 *
 * The bridge only listens on this Mac's Tailscale addresses, so the phone
 * has to be on the same tailnet; this says so when Tailscale is not up
 * rather than offering a code no phone could reach.
 */
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { REMOTE_EVENT, type RemoteStatus } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore } from "../store";

function when(at: number | null): string {
  if (!at) return "never";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : new Date(at).toLocaleDateString();
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

  const run = (action: () => Promise<unknown>) => {
    action()
      .then(refresh)
      .catch((error: unknown) => setError(error));
  };

  if (!status) return null;
  const reachable = status.tailscale.length > 0;
  const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;

  return (
    <section className="phone-section">
      <h3>Phone</h3>
      <p className="small muted">
        Follow and control this Mac&rsquo;s sessions and Big Things from the ThingMaker app on your Android phone. The phone reaches this Mac over Tailscale only —
        never the open internet — and each phone gets its own key, which you can revoke here. Sign-ins, provider settings, the terminal, git and file writes stay on
        the Mac.
      </p>
      <label className="check">
        <input checked={status.enabled} onChange={(event) => run(() => api.remoteSetEnabled(event.target.checked))} type="checkbox" /> Allow phone access
      </label>

      {status.enabled && (
        <>
          {reachable ? (
            <p className="small">
              Reachable as <strong>{status.name}</strong> at <span className="mono">{status.tailscale.map((ip) => `${ip}:${status.port}`).join(", ")}</span> on your
              tailnet.
            </p>
          ) : (
            <p className="small chip-warn">
              Tailscale is not running on this Mac, so no phone can reach it. Install Tailscale, sign in, and sign in with the same account on the phone; this page
              notices within half a minute.
            </p>
          )}

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
            <button className="button" disabled={!reachable} onClick={() => run(api.remotePairStart)} title={reachable ? undefined : "Start Tailscale first"} type="button">
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
                  <button className="link small" onClick={() => run(() => api.remoteDeviceRevoke(device.id))} type="button">
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
