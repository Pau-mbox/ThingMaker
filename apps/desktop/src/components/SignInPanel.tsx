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
import { ProviderLogo } from "./ProviderLogo";
import { PROVIDER_LABELS } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore, type SignInRun } from "../store";
import { t } from "../i18n";
import { windowName } from "./UsageLine";

/** What each provider is, in one line, for someone choosing between them. */
const BLURB = (): Record<Provider, string> => ({
  claude: t("Claude Code, through its ACP adapter (claude-agent-acp). Signs in with your Claude Pro, Max, Team or Enterprise plan."),
  codex: t("Codex, through its app-server. Signs in with your ChatGPT plan."),
  gemini: t(
    "Gemini (and the other models in your Antigravity quota) through Antigravity's own CLI, agy. It shares the Antigravity app's sign-in. A worker or a plain session: it cannot lead a team. In a trusted workspace it runs with agy's --dangerously-skip-permissions, so it may edit files and run commands without asking.",
  ),
});

/** Providers whose sign-in lives in another app rather than a flow here. */
const SIGNS_IN_ELSEWHERE = (): Partial<Record<Provider, string>> => ({
  gemini: t("Sign in or switch accounts in the Antigravity app, or run `agy` once in a terminal."),
});

/** Where a sign-in run is, as the person reads it. */
const SIGN_IN_STATE = (): Record<SignInRun["state"], string> => ({
  starting: t("starting"),
  running: t("running"),
  success: t("success"),
  failed: t("failed"),
  cancelled: t("cancelled"),
  timed_out: t("timed out"),
});

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
    <li className="card provider-card">
      <ProviderLogo provider={info.provider} size={44} />
      <div className="provider-body">
        <div className="row wrap">
          <strong className="provider-name">{info.label}</strong>
          {!info.resolved && <span className="chip small chip-warn">{t("not found")}</span>}
          {auth?.loggedIn === true && (
            <span className="chip small chip-active">
              {auth.account ? t("signed in as {account}", { account: auth.account }) : t("signed in")}
              {auth.plan ? ` · ${auth.plan}` : ""}
            </span>
          )}
          {auth?.loggedIn === false && <span className="chip small chip-warn">{t("not signed in")}</span>}
          {auth?.problem && <span className="chip small">{auth.problem}</span>}
          {quota?.primary && (
            <span className="chip small" title={t("As the provider last reported it")}>
              {[quota.primary, quota.secondary]
                .filter((w): w is NonNullable<typeof w> => !!w)
                .map((w) => t("{window} {percent}% left", { window: windowName(w.windowSeconds), percent: Math.max(0, 100 - Math.round(w.usedPercent)) }))
                .join(" · ")}
              {quota.limitReached ? ` · ${t("limit reached")}` : ""}
            </span>
          )}
        </div>
        <p className="small muted">{BLURB()[info.provider]}</p>
        {info.resolved ? (
          <p className="small muted mono">
            {info.resolved.program} {info.resolved.prefixArgs.join(" ")} <span className="chip small">{info.resolved.source}</span>
          </p>
        ) : (
          <p className="small chip-warn">{info.problem}</p>
        )}
        {SIGNS_IN_ELSEWHERE()[info.provider] && <p className="small muted">{SIGNS_IN_ELSEWHERE()[info.provider]}</p>}
        <VersionRow provider={info.provider} />
        <div className="row wrap">
          {SIGNS_IN_ELSEWHERE()[info.provider] ? null : auth?.loggedIn ? (
            <button className="button" disabled={!info.resolved || running || !!(signIn && signIn.state === "running")} onClick={() => void switchAccount(info.provider)} type="button">
              {t("Switch account")}
            </button>
          ) : (
            <button className="button button-primary" disabled={!info.resolved || running || !!(signIn && signIn.state === "running")} onClick={() => void startSignIn(info.provider)} type="button">
              {t("Sign in with subscription")}
            </button>
          )}
          {running && (
            <button className="button button-warn" onClick={() => void cancelSignIn()} type="button">
              {t("Cancel sign-in")}
            </button>
          )}
          <button className="button" onClick={() => void loadProviders()} type="button">
            {t("Check again")}
          </button>
          <button className="button" disabled={!info.resolved || loadingModels} onClick={() => void listModels()} type="button">
            {loadingModels ? t("Asking…") : t("List models")}
          </button>
        </div>
        {models && (
          <ul className="call-list">
            {models.map((model) => (
              <li className="small" key={model.id}>
                <strong>{model.name}</strong> <span className="mono muted">{model.id}</span>
                {model.isDefault && <span className="chip small">{t("default")}</span>}
                {model.needsCredits && <span className="chip small chip-warn">{t("uses credits beyond the plan")}</span>}
                {model.efforts.length > 0 && <span className="muted"> · {t("effort {levels}", { levels: model.efforts.join(", ") })}</span>}
                {model.description && <span className="muted"> · {model.description}</span>}
              </li>
            ))}
            {models.length === 0 && <li className="small muted">{t("The account listed no models; it is probably not signed in.")}</li>}
          </ul>
        )}
      </div>
    </li>
  );
}

/**
 * The program's version, and an update when one is out. ThingMaker runs
 * whatever is installed, so this is where falling behind shows; the update
 * itself is the provider's own tooling (npm for the Claude adapter,
 * `agy update`), and a Codex inside the ChatGPT app updates with that app.
 */
export function VersionRow({ provider }: { provider: Provider }) {
  const version = useStore((s) => s.providerVersions?.[provider]);
  const update = useStore((s) => s.providerUpdate);
  const updateProvider = useStore((s) => s.updateProvider);
  const result = update.results[provider];
  if (!version) return null;
  const updating = update.running === provider;
  const status = version.updateAvailable
    ? t("{version} is out", { version: version.latest ?? "" })
    : version.latest
      ? t("up to date")
      : version.canUpdate
        ? null
        : version.how;
  return (
    <div className="provider-version">
      <div className="row wrap small">
        <span>
          {t("Version")} <span className="mono">{version.installed ?? t("unknown")}</span>
        </span>
        {status && <span className={version.updateAvailable ? "chip small chip-active" : "muted"}>{status}</span>}
        {/* A program whose newest release cannot be asked for (agy) gets a
            plain Update that runs its own updater; one npm already says is
            current gets no button at all. */}
        {version.canUpdate && (version.updateAvailable || !version.latest) && (
          <button
            className={`button small ${version.updateAvailable ? "button-primary" : ""}`}
            disabled={update.running !== null}
            onClick={() => void updateProvider(provider)}
            title={t("Runs {command}", { command: version.how })}
            type="button"
          >
            {updating ? t("Updating…") : version.updateAvailable ? t("Update to {version}", { version: version.latest ?? "" }) : t("Update")}
          </button>
        )}
      </div>
      {version.updateAvailable && version.tested && version.latest && version.latest !== version.tested && (
        <p className="small muted">
          {t("ThingMaker was last checked against {version}. Newer releases usually work; if a session misbehaves after updating, say so and it gets checked.", {
            version: version.tested,
          })}
        </p>
      )}
      {version.problem && <p className="small muted">{version.problem}</p>}
      {result && <p className={`small ${result.ok ? "muted" : "chip-warn"}`}>{result.text}</p>}
    </div>
  );
}

export function SignInPanel() {
  const providers = useStore((s) => s.providers);
  const loadProviders = useStore((s) => s.loadProviders);
  const loadProviderVersions = useStore((s) => s.loadProviderVersions);
  const signIn = useStore((s) => s.signIn);
  const openUrl = useStore((s) => s.openUrl);

  useEffect(() => {
    if (!providers) void loadProviders();
  }, [providers, loadProviders]);
  useEffect(() => {
    void loadProviderVersions();
  }, [loadProviderVersions]);

  return (
    <div className="panel">
      <h2>{t("Providers")}</h2>
      <p className="small muted">
        {t(
          "Each provider runs its own official program with its own sign-in, on your subscription. The desktop never sees a token: sign-in happens in the provider\u2019s own flow, in your browser, and each program keeps its credentials in its own store.",
        )}
      </p>

      {!providers ? (
        <p className="muted small">{t("Asking each provider…")}</p>
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
            {t("Sign-in")} · {PROVIDER_LABELS[signIn.provider]} · {SIGN_IN_STATE()[signIn.state] ?? signIn.state}
          </h3>
          {signIn.urls.length > 0 && (
            <div className="row wrap">
              {signIn.urls.map((url) => (
                <span className="row" key={url}>
                  <span className="mono small url">{url}</span>
                  <button className="button small" onClick={() => void openUrl(url)} type="button">
                    {t("Open in browser")}
                  </button>
                </span>
              ))}
            </div>
          )}
          {signIn.state === "running" && signIn.urls.length > 0 && <p className="small muted">{t("Complete the sign-in in your browser; the program exits when it is done.")}</p>}
          <pre className="text log">{signIn.lines.map((line) => `${line.stream === "stderr" ? "! " : "  "}${line.text}`).join("\n") || t("(no output yet)")}</pre>
        </section>
      )}
    </div>
  );
}
