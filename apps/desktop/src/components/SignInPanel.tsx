/**
 * Providers: every subscription the desktop can drive, where its program is,
 * which account it is signed in as, what that account's quota says, and the
 * models it can select.
 *
 * Every answer comes from the provider's own official program. Sign-in runs
 * that program's own login as a separate process on the *subscription* (never
 * API billing); tokens never pass through the desktop, and URLs open only
 * when you click them.
 */
import { useEffect, useState } from "react";
import type { Provider, ProviderInfo, ProviderModel } from "@thingmaker/contracts";
import { PROVIDER_LABELS } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore } from "../store";
import { windowName } from "./UsageLine";

/** What each provider is, in one line, for someone choosing between them. */
const BLURB: Record<Provider, string> = {
  claude: "Claude Code, through its ACP adapter (claude-agent-acp). Signs in with your Claude Pro, Max, Team or Enterprise plan.",
  codex: "Codex, through its app-server. Signs in with your ChatGPT plan.",
  gemini:
    "Gemini (and the other models in your Antigravity quota) through Antigravity's own CLI, agy. It shares the Antigravity app's sign-in. A worker or a plain session: it cannot lead a team. In a trusted workspace it runs with agy's --dangerously-skip-permissions, so it may edit files and run commands without asking.",
};

/** Providers whose sign-in lives in another app rather than a flow here. */
const SIGNS_IN_ELSEWHERE: Partial<Record<Provider, string>> = {
  gemini: "Sign in or switch accounts in the Antigravity app, or run `agy` once in a terminal.",
};

function ProviderCard({ info }: { info: ProviderInfo }) {
  const signIn = useStore((s) => s.signIn);
  const startSignIn = useStore((s) => s.startSignIn);
  const switchAccount = useStore((s) => s.switchAccount);
  const cancelSignIn = useStore((s) => s.cancelSignIn);
  const loadProviders = useStore((s) => s.loadProviders);
  const quota = useStore((s) => s.usage[info.provider]);
  const setError = useStore((s) => s.setError);
  const [models, setModels] = useState<ProviderModel[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const running = signIn?.provider === info.provider && (signIn.state === "starting" || signIn.state === "running");
  const auth = info.auth;

  const listModels = async () => {
    setLoadingModels(true);
    try {
      setModels(await api.providerModels(info.provider));
    } catch (error) {
      setError(error);
    } finally {
      setLoadingModels(false);
    }
  };

  return (
    <li className="card">
      <div className="row wrap">
        <strong>{info.label}</strong>
        {!info.resolved && <span className="chip small chip-warn">not found</span>}
        {auth?.loggedIn === true && (
          <span className="chip small chip-active">
            signed in{auth.account ? ` as ${auth.account}` : ""}
            {auth.plan ? ` · ${auth.plan}` : ""}
          </span>
        )}
        {auth?.loggedIn === false && <span className="chip small chip-warn">not signed in</span>}
        {auth?.problem && <span className="chip small">{auth.problem}</span>}
        {quota?.primary && (
          <span className="chip small" title="As the provider last reported it">
            {[quota.primary, quota.secondary]
              .filter((w): w is NonNullable<typeof w> => !!w)
              .map((w) => `${windowName(w.windowSeconds)} ${Math.max(0, 100 - Math.round(w.usedPercent))}% left`)
              .join(" · ")}
            {quota.limitReached ? " · limit reached" : ""}
          </span>
        )}
      </div>
      <p className="small muted">{BLURB[info.provider]}</p>
      {info.resolved ? (
        <p className="small muted mono">
          {info.resolved.program} {info.resolved.prefixArgs.join(" ")} <span className="chip small">{info.resolved.source}</span>
        </p>
      ) : (
        <p className="small chip-warn">{info.problem}</p>
      )}
      {SIGNS_IN_ELSEWHERE[info.provider] && <p className="small muted">{SIGNS_IN_ELSEWHERE[info.provider]}</p>}
      <div className="row wrap">
        {SIGNS_IN_ELSEWHERE[info.provider] ? null : auth?.loggedIn ? (
          <button className="button" disabled={!info.resolved || running || !!(signIn && signIn.state === "running")} onClick={() => void switchAccount(info.provider)} type="button">
            Switch account
          </button>
        ) : (
          <button className="button button-primary" disabled={!info.resolved || running || !!(signIn && signIn.state === "running")} onClick={() => void startSignIn(info.provider)} type="button">
            Sign in with subscription
          </button>
        )}
        {running && (
          <button className="button button-warn" onClick={() => void cancelSignIn()} type="button">
            Cancel sign-in
          </button>
        )}
        <button className="button" onClick={() => void loadProviders()} type="button">
          Check again
        </button>
        <button className="button" disabled={!info.resolved || loadingModels} onClick={() => void listModels()} type="button">
          {loadingModels ? "Asking…" : "List models"}
        </button>
      </div>
      {models && (
        <ul className="call-list">
          {models.map((model) => (
            <li className="small" key={model.id}>
              <strong>{model.name}</strong> <span className="mono muted">{model.id}</span>
              {model.isDefault && <span className="chip small">default</span>}
              {model.needsCredits && <span className="chip small chip-warn">uses credits beyond the plan</span>}
              {model.efforts.length > 0 && <span className="muted"> · effort {model.efforts.join(", ")}</span>}
              {model.description && <span className="muted"> · {model.description}</span>}
            </li>
          ))}
          {models.length === 0 && <li className="small muted">The account listed no models; it is probably not signed in.</li>}
        </ul>
      )}
    </li>
  );
}

export function SignInPanel() {
  const providers = useStore((s) => s.providers);
  const loadProviders = useStore((s) => s.loadProviders);
  const signIn = useStore((s) => s.signIn);
  const openUrl = useStore((s) => s.openUrl);

  useEffect(() => {
    if (!providers) void loadProviders();
  }, [providers, loadProviders]);

  return (
    <div className="panel">
      <h2>Providers</h2>
      <p className="small muted">
        Each provider runs its own official program with its own sign-in, on your subscription. The desktop never sees a token: sign-in happens in the provider&rsquo;s
        own flow, in your browser, and each program keeps its credentials in its own store.
      </p>

      {!providers ? (
        <p className="muted small">Asking each provider…</p>
      ) : (
        <ul className="providers">
          {providers.map((info) => (
            <ProviderCard info={info} key={info.provider} />
          ))}
        </ul>
      )}

      {signIn && (
        <section className="card">
          <h3>
            Sign-in · {PROVIDER_LABELS[signIn.provider]} · {signIn.state.replace("_", " ")}
          </h3>
          {signIn.urls.length > 0 && (
            <div className="row wrap">
              {signIn.urls.map((url) => (
                <span className="row" key={url}>
                  <span className="mono small url">{url}</span>
                  <button className="button small" onClick={() => void openUrl(url)} type="button">
                    Open in browser
                  </button>
                </span>
              ))}
            </div>
          )}
          {signIn.state === "running" && signIn.urls.length > 0 && <p className="small muted">Complete the sign-in in your browser; the program exits when it is done.</p>}
          <pre className="text log">{signIn.lines.map((line) => `${line.stream === "stderr" ? "! " : "  "}${line.text}`).join("\n") || "(no output yet)"}</pre>
        </section>
      )}
    </div>
  );
}
