/**
 * Phone access, in Settings: turn the bridge on, pair a phone by scanning a
 * QR code, see which phones are connected, and revoke one.
 *
 * The phone reaches this computer one of two ways, the user's choice:
 * through the user's own relay (a Cloudflare Worker behind Cloudflare
 * Access), or directly through the user's own tunnel to a local port. This
 * asks for that address and an Access service token, says whether the
 * computer is reachable that way, and
 * rather than offering a code no phone could reach.
 */
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { REMOTE_EVENT, type ConnectionMode, type RemoteStatus } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore } from "../store";
import { t } from "../i18n";

/** What the phone last said about an app it was sent. */
const OFFER_STATE = (): Record<string, string> => ({
  sent: t("sent — waiting for the phone"),
  downloading: t("downloading to the phone"),
  confirm: t("waiting for you to confirm on the phone"),
  installed: t("installed"),
  failed: t("not installed"),
  cancelled: t("cancelled on the phone"),
});

function when(at: number | null): string {
  if (!at) return t("never");
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return t("just now");
  if (minutes < 60) return t("{minutes}m ago", { minutes });
  const hours = Math.round(minutes / 60);
  return hours < 48 ? t("{hours}h ago", { hours }) : new Date(at).toLocaleDateString();
}

const RELAY_STATE = (): Record<string, string> => ({
  off: t("not connected"),
  connecting: t("connecting…"),
  connected: t("connected"),
  error: t("can't connect"),
});

const MODE_LABEL = (): Record<ConnectionMode, string> => ({
  relay: t("Through my Cloudflare relay"),
  direct: t("Direct, through my own tunnel"),
});

/**
 * How the phone reaches this computer, and the details of that way: the
 * relay's address, or the public address of the user's own tunnel to this
 * computer's port; either with an optional Cloudflare Access service token
 * (the relay needs one).
 */
function ConnectionForm({ status, onSaved }: { status: RemoteStatus; onSaved: () => void }) {
  const setError = useStore((s) => s.setError);
  const [mode, setMode] = useState<ConnectionMode>(status.mode);
  const saved = (which: ConnectionMode) => (which === "relay" ? status.relay.url : status.directUrl) ?? "";
  const [url, setUrl] = useState(saved(status.mode));
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [editing, setEditing] = useState(!saved(status.mode));
  const save = () =>
    api
      .remoteSetConnection(mode, url, id, secret)
      .then(() => {
        setId("");
        setSecret("");
        setEditing(false);
        onSaved();
      })
      .catch((error: unknown) => setError(error));
  const relay = status.relay;
  const port = status.listening[0] ?? `127.0.0.1:${status.port}`;
  const current = saved(status.mode);
  if (current && !editing) {
    return (
      <div className="phone-relay">
        <p className="small">
          {MODE_LABEL()[status.mode]}: <span className="mono">{current}</span>
          {status.mode === "relay" ? (
            <>
              {" · "}
              <span className={relay.state === "connected" ? "" : relay.state === "error" ? "chip-warn" : "muted"}>{RELAY_STATE()[relay.state] ?? relay.state}</span>
            </>
          ) : (
            <span className="muted"> · {t("forwarded to {port}", { port })}</span>
          )}
          {relay.access ? ` · ${t("Cloudflare Access on")}` : status.mode === "relay" ? ` · ${t("no Access token set")}` : ""}{" "}
          <button
            className="link small"
            onClick={() => {
              setMode(status.mode);
              setUrl(current);
              setEditing(true);
            }}
            type="button"
          >
            {t("change")}
          </button>
          {status.mode === "relay" && relay.message && <span className="small muted"> — {relay.message}</span>}
        </p>
      </div>
    );
  }
  return (
    <div className="phone-relay">
      <form
        className="phone-relay-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="row" role="radiogroup" aria-label={t("How the phone reaches this computer")}>
          {(["relay", "direct"] as const).map((choice) => (
            <label className="check small" key={choice}>
              <input
                checked={mode === choice}
                name="phone-mode"
                onChange={() => {
                  setMode(choice);
                  setUrl(saved(choice));
                }}
                type="radio"
              />{" "}
              {MODE_LABEL()[choice]}
            </label>
          ))}
        </div>
        {mode === "relay" ? (
          <p className="small muted">
            {t("Deploy the relay once with")} <span className="mono">pnpm relay:deploy</span>{" "}
            {t("(it asks you to sign in to Cloudflare), turn on Cloudflare Access in the Worker\u2019s Access tab with a service token, and paste the details here. This computer only connects out. The README has the steps.")}
          </p>
        ) : (
          <p className="small muted">
            {t("This computer listens on")} <span className="mono">{port}</span>{" "}
            {t("(this computer only). Expose that port at an HTTPS address with your own tunnel — for example")}{" "}
            <span className="mono">cloudflared tunnel --url http://{port}</span>, <span className="mono">tailscale funnel {status.port}</span>,{" "}
            {t("or an SSH reverse forward to a server — and paste the public address. Cloudflare Access in front of it is optional. The README has the steps.")}
          </p>
        )}
        <input
          aria-label={mode === "relay" ? t("Relay address") : t("Tunnel address")}
          className="input"
          onChange={(event) => setUrl(event.target.value)}
          placeholder={mode === "relay" ? "https://thingmaker-relay.you.workers.dev" : "https://thingmaker.example.com"}
          value={url}
        />
        <input aria-label={t("Access client ID")} className="input" onChange={(event) => setId(event.target.value)} placeholder={relay.access ? t("Access client ID (saved)") : mode === "relay" ? t("Access client ID") : t("Access client ID (optional)")} value={id} />
        <input
          aria-label={t("Access client secret")}
          className="input"
          onChange={(event) => setSecret(event.target.value)}
          placeholder={relay.access ? t("Access client secret (saved)") : mode === "relay" ? t("Access client secret") : t("Access client secret (optional)")}
          type="password"
          value={secret}
        />
        <div className="row">
          <button className="button button-small button-primary" disabled={!url.trim()} type="submit">
            {t("Save")}
          </button>
          {current && (
            <button className="button button-small" onClick={() => setEditing(false)} type="button">
              {t("Cancel")}
            </button>
          )}
          {relay.access && (
            <button className="link small" onClick={() => void api.remoteClearAccess().then(onSaved).catch((error: unknown) => setError(error))} type="button">
              {t("forget the Access token")}
            </button>
          )}
        </div>
      </form>
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
  // Ready for a phone: the relay connected, or the tunnel's address set and
  // the port listening.
  const reachable = status.mode === "relay" ? status.relay.state === "connected" : !!status.directUrl && status.listening.length > 0;
  const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;

  return (
    <section className="phone-section">
      <h3>{t("Phone")}</h3>
      <p className="small muted">
        {t(
          "Follow and control this computer\u2019s sessions and Big Things from the ThingMaker app on your Android phone, from anywhere. Choose how the phone reaches this computer: through your own relay on Cloudflare (this computer only connects out) or directly through your own tunnel. Each phone gets its own key, which you can revoke here. Sign-ins, provider settings, the terminal, git and file writes stay on this computer.",
        )}
      </p>
      <label className="check">
        <input checked={status.enabled} onChange={(event) => run(() => api.remoteSetEnabled(event.target.checked))} type="checkbox" /> {t("Allow phone access")}
      </label>

      {status.enabled && (
        <>
          <ConnectionForm onSaved={refresh} status={status} />

          {pairing ? (
            <div className="phone-pairing">
              <div className="phone-qr" dangerouslySetInnerHTML={{ __html: pairing.qrSvg }} />
              <div>
                <p className="small">
                  {t("In the ThingMaker app on your phone, tap")} <strong>{t("Pair with a computer")}</strong> {t("and scan this code. Or type the code:")}
                </p>
                <p className="mono phone-code">{pairing.code.replace(/(.{5})/, "$1 ")}</p>
                <p className="small muted">
                  {t("Good for {time}, once.", { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` })}
                </p>
                <button className="button button-small" onClick={() => run(api.remotePairCancel)} type="button">
                  {t("Cancel")}
                </button>
              </div>
            </div>
          ) : (
            <button className="button" disabled={!reachable} onClick={() => run(api.remotePairStart)} title={reachable ? undefined : status.mode === "relay" ? t("Connect this computer to its relay first") : t("Set the tunnel\u2019s address first")} type="button">
              {t("Pair a phone")}
            </button>
          )}

          {status.devices.length > 0 && (
            <ul className="phone-devices">
              {status.devices.map((device) => (
                <li key={device.id}>
                  <span className={`phone-dot ${device.connected ? "phone-dot-on" : ""}`} title={device.connected ? t("Connected now") : t("Not connected")} />
                  <strong>{device.name}</strong>
                  <span className="small muted">
                    {device.connected ? t("connected") : t("last seen {when}", { when: when(device.lastSeen) })} · {t("paired {date}", { date: new Date(device.pairedAt).toLocaleDateString() })}
                  </span>
                  {device.connected && (
                    <button className="link small" onClick={() => void sendApk(device.id)} title={t("Install an Android app on this phone: it asks you to confirm there")} type="button">
                      {t("Send an app…")}
                    </button>
                  )}
                  <button className="link small" onClick={() => run(() => api.remoteDeviceRevoke(device.id))} type="button">
                    {t("Revoke")}
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
                    {OFFER_STATE()[offer.state] ?? offer.state}
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
