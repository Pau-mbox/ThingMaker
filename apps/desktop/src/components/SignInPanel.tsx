/**
 * Providers: every subscription the desktop can drive, one row each — its
 * state in a word, how much of its windows is left, and the one thing to do
 * when something needs doing (sign in, update). Where the program lives, the
 * account, the version and the models wait behind (?) and the ⋯ menu.
 *
 * Every answer comes from the provider's own official program. Sign-in runs
 * that program's own login as a separate process on the *subscription* (never
 * API billing); tokens never pass through the desktop, and URLs open only
 * when you click them.
 */
import { useEffect, useRef, useState } from "react";
import { PROVIDER_LABELS, type Provider, type ProviderInfo, type ProviderModel } from "@thingmaker/contracts";
import { ProviderLogo } from "./ProviderLogo";
import { api } from "../ipc";
import { useStore, type SignInRun } from "../store";
import { t } from "../i18n";
import { windowName } from "./UsageLine";
import { IconDots, IconRefresh } from "./icons";

/** What a provider signs in with, for someone who has not yet. */
const USES = (): Record<Provider, string> => ({
  claude: t("Uses your Claude Pro, Max, Team or Enterprise plan"),
  codex: t("Uses your ChatGPT plan"),
  gemini: t("Signs in through the Antigravity app"),
});

/** How it signs in and runs, for the details. */
const SIGNS_IN_WITH = (): Record<Provider, string> => ({
  claude: t("Your Claude plan, through its ACP adapter"),
  codex: t("Your ChatGPT plan, through its app-server"),
  gemini: t("The Antigravity app's sign-in, through its own CLI"),
});

/** Providers whose sign-in lives in another app rather than a flow here. */
const SIGNS_IN_ELSEWHERE: Partial<Record<Provider, true>> = { gemini: true };

/** Where a sign-in run is, as the person reads it. */
const SIGN_IN_STATE = (): Record<SignInRun["state"], string> => ({
  starting: t("Starting the sign-in…"),
  running: t("Waiting for you to finish in your browser."),
  success: t("Signed in."),
  failed: t("The sign-in did not finish."),
  cancelled: t("Sign-in cancelled."),
  timed_out: t("The sign-in timed out."),
});

const SOURCE = (): Record<"settings" | "environment" | "discovered", string> => ({
  settings: t("set in Settings"),
  environment: t("from the environment"),
  discovered: t("found on this computer"),
});

function Help({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button aria-expanded={open} aria-label={label} className="help-dot" onClick={onToggle} title={label} type="button">
      ?
    </button>
  );
}

function Meters({ provider }: { provider: Provider }) {
  const usage = useStore((s) => s.usage[provider]);
  if (!usage) return null;
  const windows = [usage.primary, usage.secondary].filter((window): window is NonNullable<typeof window> => !!window);
  return (
    <>
      {windows.map((window) => {
        const left = Math.max(0, 100 - Math.round(window.usedPercent));
        const name = windowName(window.windowSeconds);
        return (
          <span className="provider-meter" key={name} title={t("{percent}% left in the {window} window, as the provider last reported it", { percent: left, window: name })}>
            <span className="provider-meter-bar">
              <span className={left < 25 ? "low" : ""} style={{ width: `${left}%` }} />
            </span>
            <b>{left}%</b> {name}
          </span>
        );
      })}
      {usage.limitReached && <span className="chip-warn-text">{t("limit reached")}</span>}
    </>
  );
}

function ProviderRow({ info }: { info: ProviderInfo }) {
  const signIn = useStore((s) => s.signIn);
  const startSignIn = useStore((s) => s.startSignIn);
  const switchAccount = useStore((s) => s.switchAccount);
  const cancelSignIn = useStore((s) => s.cancelSignIn);
  const openUrl = useStore((s) => s.openUrl);
  const loadProviders = useStore((s) => s.loadProviders);
  const setError = useStore((s) => s.setError);
  const version = useStore((s) => s.providerVersions?.[info.provider]);
  const update = useStore((s) => s.providerUpdate);
  const updateProvider = useStore((s) => s.updateProvider);
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState(false);
  const [output, setOutput] = useState(false);
  const [models, setModels] = useState<ProviderModel[] | null>(null);
  const [showModels, setShowModels] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);

  const provider = info.provider;
  const auth = info.auth;
  const run = signIn?.provider === provider ? signIn : null;
  const signingIn = run !== null && (run.state === "starting" || run.state === "running");
  const elsewhere = SIGNS_IN_ELSEWHERE[provider] === true;
  const updating = update.running === provider;
  const result = update.results[provider];
  const canUpdateTo = version?.updateAvailable && version.canUpdate ? version.latest : undefined;

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const toggleModels = async () => {
    setMenu(false);
    if (showModels) return setShowModels(false);
    setShowModels(true);
    if (models) return;
    setLoadingModels(true);
    try {
      setModels(await api.providerModels(provider));
    } catch (error) {
      setError(error);
      setShowModels(false);
    } finally {
      setLoadingModels(false);
    }
  };

  const status = !info.resolved
    ? { tone: "warn", text: t("Not installed") }
    : signingIn
      ? { tone: "busy", text: t("Signing in…") }
      : auth?.loggedIn === true
        ? { tone: "ok", text: auth.plan ? t("Ready · {plan}", { plan: auth.plan }) : t("Ready") }
        : auth?.loggedIn === false
          ? { tone: "warn", text: t("Not signed in") }
          : { tone: "", text: t("Not checked yet") };

  const main = !info.resolved ? null : signingIn ? (
    <button className="button" onClick={() => void cancelSignIn()} type="button">
      {t("Cancel")}
    </button>
  ) : auth?.loggedIn === false && !elsewhere ? (
    <button className="button button-primary" disabled={signIn?.state === "running"} onClick={() => void startSignIn(provider)} type="button">
      {t("Sign in")}
    </button>
  ) : updating ? (
    <button className="button button-small" disabled type="button">
      {t("Updating…")}
    </button>
  ) : canUpdateTo ? (
    <button className="button button-small" disabled={update.running !== null} onClick={() => void updateProvider(provider)} title={t("Runs {command}", { command: version?.how ?? "" })} type="button">
      {t("Update to {version}", { version: canUpdateTo })}
    </button>
  ) : null;

  const versionText = version
    ? [version.installed ?? t("unknown"), version.updateAvailable ? t("{version} is out", { version: version.latest ?? "" }) : version.latest ? t("up to date") : version.how].join(" · ")
    : null;
  const showDrawer = details || showModels || run !== null || Boolean(result);

  return (
    <li className="provider-row">
      <div className="provider-row-main">
        <ProviderLogo provider={provider} size={38} />
        <div className="provider-who">
          <div className="provider-name-line">
            <strong>{info.label}</strong>
            <span className={`provider-status ${status.tone}`}>
              <i />
              {status.text}
            </span>
            {version?.updateAvailable && !updating && <span className="chip small chip-update">{t("update")}</span>}
          </div>
          <div className="provider-sub">
            {auth?.loggedIn === true && !signingIn && <Meters provider={provider} />}
            {elsewhere && auth?.loggedIn === true && <span>{t("Signed in through Antigravity")}</span>}
            {info.resolved && auth?.loggedIn === false && !signingIn && <span>{USES()[provider]}</span>}
            {!info.resolved && <span>{t("ThingMaker could not find its program.")}</span>}
          </div>
        </div>
        <div className="provider-actions">
          {main}
          <Help label={t("{provider} details", { provider: info.label })} onToggle={() => setDetails(!details)} open={details} />
          <span className="provider-menu-wrap" ref={menuRef}>
            <button aria-expanded={menu} aria-label={t("More for {provider}", { provider: info.label })} className="icon-button" onClick={() => setMenu(!menu)} type="button">
              <IconDots size={15} />
            </button>
            {menu && (
              <div className="provider-menu" role="menu">
                {info.resolved && !elsewhere && auth?.loggedIn === true && (
                  <button
                    onClick={() => {
                      setMenu(false);
                      void switchAccount(provider);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    {t("Switch account")}
                  </button>
                )}
                {info.resolved && (
                  <button onClick={() => void toggleModels()} role="menuitem" type="button">
                    {showModels ? t("Hide models") : t("Show models")}
                  </button>
                )}
                <button
                  onClick={() => {
                    setMenu(false);
                    setDetails(!details);
                  }}
                  role="menuitem"
                  type="button"
                >
                  {details ? t("Hide details") : t("Details")}
                </button>
                {version?.canUpdate && !version.latest && (
                  <button
                    disabled={update.running !== null}
                    onClick={() => {
                      setMenu(false);
                      void updateProvider(provider);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    {t("Run its updater")}
                  </button>
                )}
                <hr />
                <button
                  onClick={() => {
                    setMenu(false);
                    void loadProviders();
                  }}
                  role="menuitem"
                  type="button"
                >
                  {t("Check again")}
                </button>
              </div>
            )}
          </span>
        </div>
      </div>

      {showDrawer && (
        <div className="provider-drawer">
          {run && (
            <div className="provider-progress">
              <span>{SIGN_IN_STATE()[run.state]}</span>
              <span className="composer-spacer" />
              {signingIn &&
                run.urls.map((url) => (
                  <button className="button button-small" key={url} onClick={() => void openUrl(url)} title={url} type="button">
                    {t("Open the sign-in page")}
                  </button>
                ))}
              <button className="link small" onClick={() => setOutput(!output)} type="button">
                {output ? t("Hide output") : t("Show output")}
              </button>
            </div>
          )}
          {run && output && <pre className="text log">{run.lines.map((line) => `${line.stream === "stderr" ? "! " : "  "}${line.text}`).join("\n") || t("(no output yet)")}</pre>}
          {result && <p className={`small ${result.ok ? "muted" : "chip-warn-text"}`}>{result.text}</p>}
          {showModels && (
            <div className="provider-models">
              {loadingModels && <span className="small muted">{t("Asking…")}</span>}
              {models?.map((model) => (
                <span className="provider-model" key={model.id} title={model.description ?? model.id}>
                  <b>
                    {model.name}
                    {model.isDefault && <span className="chip small">{t("default")}</span>}
                    {model.needsCredits && <span className="chip small chip-warn">{t("credits")}</span>}
                  </b>
                  {model.efforts.length > 0 && <span className="small muted">{t("effort {levels}", { levels: model.efforts.join(", ") })}</span>}
                </span>
              ))}
              {models?.length === 0 && <span className="small muted">{t("The account listed no models; it is probably not signed in.")}</span>}
            </div>
          )}
          {details && (
            <dl className="provider-facts">
              <dt>{t("Signs in with")}</dt>
              <dd>{SIGNS_IN_WITH()[provider]}</dd>
              {(auth?.account || auth?.method) && (
                <>
                  <dt>{t("Account")}</dt>
                  <dd>{[auth.account, auth.plan, auth.method].filter(Boolean).join(" · ")}</dd>
                </>
              )}
              {auth?.problem && (
                <>
                  <dt>{t("Sign-in check")}</dt>
                  <dd>{auth.problem}</dd>
                </>
              )}
              {versionText && (
                <>
                  <dt>{t("Version")}</dt>
                  <dd>{versionText}</dd>
                </>
              )}
              {version?.updateAvailable && version.tested && version.latest && version.latest !== version.tested && (
                <>
                  <dt>{t("Tested with")}</dt>
                  <dd>{t("{version}; newer releases usually work. If a session misbehaves after updating, say so.", { version: version.tested })}</dd>
                </>
              )}
              {version?.problem && (
                <>
                  <dt>{t("Version check")}</dt>
                  <dd>{version.problem}</dd>
                </>
              )}
              <dt>{t("Program")}</dt>
              <dd>
                {info.resolved ? (
                  <>
                    <code>{[info.resolved.program, ...info.resolved.prefixArgs].join(" ")}</code> · {SOURCE()[info.resolved.source]}
                  </>
                ) : (
                  (info.problem ?? t("not found"))
                )}
              </dd>
              {elsewhere && (
                <>
                  <dt>{t("Accounts")}</dt>
                  <dd>{t("Sign in or switch accounts in the Antigravity app, or run `agy` once in a terminal.")}</dd>
                </>
              )}
              {provider === "gemini" && (
                <>
                  <dt>{t("Good to know")}</dt>
                  <dd>{t("A helper or a plain session: it cannot lead a team. In a trusted project it runs without asking before it edits files or runs commands.")}</dd>
                </>
              )}
            </dl>
          )}
        </div>
      )}
    </li>
  );
}

export function SignInPanel() {
  const providers = useStore((s) => s.providers);
  const loadProviders = useStore((s) => s.loadProviders);
  const loadProviderVersions = useStore((s) => s.loadProviderVersions);
  const versions = useStore((s) => s.providerVersions);
  const update = useStore((s) => s.providerUpdate);
  const updateProvider = useStore((s) => s.updateProvider);
  const [about, setAbout] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!providers) void loadProviders();
  }, [providers, loadProviders]);
  useEffect(() => {
    void loadProviderVersions();
  }, [loadProviderVersions]);

  const pending = Object.values(versions ?? {}).filter((version): version is NonNullable<typeof version> => Boolean(version?.updateAvailable && version.canUpdate && version.latest));
  const checkAll = async () => {
    setChecking(true);
    await Promise.all([loadProviders(), loadProviderVersions()]).finally(() => setChecking(false));
  };
  const updateAll = async () => {
    for (const version of pending) await updateProvider(version.provider);
  };

  return (
    <div className="panel providers-panel">
      <div className="row providers-head">
        <h2>{t("Providers")}</h2>
        <Help label={t("About providers")} onToggle={() => setAbout(!about)} open={about} />
        <span className="composer-spacer" />
        <button aria-label={t("Check all again")} className="icon-button" disabled={checking} onClick={() => void checkAll()} title={t("Check all again")} type="button">
          <IconRefresh size={15} />
        </button>
      </div>
      {about && (
        <p className="providers-about small">
          {t("Each provider runs its own official program and signs in with your own subscription, in your browser. ThingMaker never sees a password or a token.")}
        </p>
      )}

      {pending.length > 0 && (
        <div className="providers-updates">
          <span className="providers-updates-dot" />
          <span className="small">
            {pending.length === 1 ? t("An update:") : t("{count} updates:", { count: pending.length })} {pending.map((version) => `${PROVIDER_LABELS[version.provider]} ${version.latest}`).join(", ")}
          </span>
          <span className="composer-spacer" />
          <button className="button button-small" disabled={update.running !== null} onClick={() => void updateAll()} type="button">
            {pending.length === 1 ? t("Update") : t("Update all")}
          </button>
        </div>
      )}

      {!providers ? (
        <p className="muted small">{t("Asking each provider…")}</p>
      ) : (
        <ul className="providers">
          {providers.map((info) => (
            <ProviderRow info={info} key={info.provider} />
          ))}
        </ul>
      )}
    </div>
  );
}
