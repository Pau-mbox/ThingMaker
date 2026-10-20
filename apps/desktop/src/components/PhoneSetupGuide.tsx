/**
 * Step-by-step setup for each way the phone can reach this computer, opened
 * from Settings → Phone. Commands, addresses and dashboard paths are shown
 * as they are; the words around them follow the interface language.
 */
import { useEffect, type ReactNode } from "react";
import type { ConnectionMode } from "@thingmaker/contracts";
import { api } from "../ipc";
import { t } from "../i18n";

type Step = { title: string; body?: ReactNode; code?: string };

function Code({ children }: { children: string }) {
  return (
    <span className="setup-code">
      <code>{children}</code>
      <button className="link small" onClick={() => void navigator.clipboard?.writeText(children)} type="button">
        {t("copy")}
      </button>
    </span>
  );
}

function Link({ href, children }: { href: string; children: string }) {
  return (
    <button className="link" onClick={() => void api.openExternal(href).catch(() => undefined)} type="button">
      {children}
    </button>
  );
}

/** A dashboard path, kept in English: Cloudflare's own menu names. */
const path = (text: string) => <span className="mono">{text}</span>;

function relaySteps(): Step[] {
  return [
    {
      title: t("Get a free Cloudflare account"),
      body: (
        <>
          {t("Sign up or sign in at")} <Link href="https://dash.cloudflare.com/sign-up">dash.cloudflare.com</Link>. {t("The relay runs on the free plan; you need no domain.")}
        </>
      ),
    },
    {
      title: t("Deploy your relay"),
      body: t("In a terminal, in your ThingMaker folder, run this. The first time it opens the browser to sign in to Cloudflare. It prints your relay's address; copy it."),
      code: "pnpm relay:deploy",
    },
    {
      title: t("Create a service token"),
      body: (
        <>
          {t("In the Cloudflare dashboard:")} {path("Zero Trust → Access → Service auth → Service Tokens → Create Service Token")}. {t("Name it, then copy the Client ID and the Client Secret. The secret is shown only once.")}
        </>
      ),
    },
    {
      title: t("Create an Access policy for that token"),
      body: (
        <>
          {path("Zero Trust → Access → Policies → Add a policy")}: {t("action")} {path("Service Auth")}, {t("include")} {path("Service Token")} {t("→ the token you just made.")}
        </>
      ),
    },
    {
      title: t("Protect the relay with it"),
      body: (
        <>
          {path("Workers & Pages → thingmaker-relay → Access")}: {t("protect all traffic and choose the policy you made (search for it by name).")}
        </>
      ),
    },
    {
      title: t("Paste the details here"),
      body: t("Choose “Through my Cloudflare relay”, paste the relay's address, the Client ID and the Client Secret, and save. The line shows “connected” once this computer reaches the relay."),
    },
    {
      title: t("Pair your phone"),
      body: t("Press “Pair a phone” and scan the code with ThingMaker Remote. The code carries the relay's address and the Access token, so the phone needs nothing else."),
    },
    {
      title: t("Check that Access is on"),
      body: t("Open your relay's address followed by /v1/hello in a browser. Cloudflare should refuse you (403). If you see ThingMaker's own reply instead, the relay is not protected yet."),
    },
  ];
}

function directSteps(port: number): Step[] {
  const target = `http://127.0.0.1:${port}`;
  return [
    {
      title: t("Choose a tunnel"),
      body: t("This computer listens on {address}, reachable only from itself. A tunnel gives that port a public HTTPS address. Pick one:", { address: `127.0.0.1:${port}` }),
    },
    {
      title: t("Option A — Cloudflare quick tunnel (to try it)"),
      body: t("Needs cloudflared installed (brew install cloudflared). It prints an address ending in trycloudflare.com. It changes every time the command starts, so you pair again after a restart."),
      code: `cloudflared tunnel --url ${target}`,
    },
    {
      title: t("Option B — Cloudflare named tunnel (with your own domain)"),
      body: (
        <>
          {path("Zero Trust → Networks → Tunnels → Create a tunnel")}. {t("Add a public hostname such as thingmaker.your-domain.com with the service")} <code>{target}</code>. {t("The address stays the same. You can put Cloudflare Access in front of it, as for the relay.")}
        </>
      ),
    },
    {
      title: t("Option C — Tailscale Funnel"),
      body: t("Needs Tailscale on this computer (the phone does not need it). It prints an address ending in ts.net."),
      code: `tailscale funnel ${port}`,
    },
    {
      title: t("Option D — SSH reverse forward to your own server"),
      body: t("Forward the port to a server you run, and serve it there over HTTPS (for example with cloudflared or a reverse proxy):"),
      code: `ssh -N -R 127.0.0.1:${port}:127.0.0.1:${port} you@your-server`,
    },
    {
      title: t("Paste the address here"),
      body: t("Choose “Direct, through my own tunnel”, paste the public https:// address, and save. If your tunnel is behind Cloudflare Access, add its service token too; otherwise leave those empty."),
    },
    {
      title: t("Pair your phone"),
      body: t("Press “Pair a phone” and scan the code with ThingMaker Remote. Keep the tunnel running while you use the phone."),
    },
  ];
}

export function PhoneSetupGuide({ mode, port, onClose }: { mode: ConnectionMode; port: number; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const steps = mode === "relay" ? relaySteps() : directSteps(port);
  return (
    <div aria-modal="true" className="modal-backdrop" onClick={onClose} role="dialog" aria-label={t("Phone setup guide")}>
      <div className="modal setup-guide" onClick={(event) => event.stopPropagation()}>
        <h2>{mode === "relay" ? t("Set up the Cloudflare relay") : t("Set up a direct tunnel")}</h2>
        <p className="small muted">
          {mode === "relay"
            ? t("Your own relay on your own Cloudflare account: free, no domain needed, and this computer only connects out.")
            : t("Your own tunnel to this computer: no Cloudflare account needed unless your tunnel uses one.")}
        </p>
        <ol className="setup-steps">
          {steps.map((step) => (
            <li key={step.title}>
              <strong>{step.title}</strong>
              {step.body && <div className="small">{step.body}</div>}
              {step.code && <Code>{step.code}</Code>}
            </li>
          ))}
        </ol>
        <div className="row">
          <button className="button button-primary" onClick={onClose} type="button">
            {t("Got it")}
          </button>
        </div>
      </div>
    </div>
  );
}
