/**
 * Runtime environment variables for Kit launches (SEC-11, F13). Values are
 * written to the OS keychain once and never displayed again; only the names
 * are listed. They are injected into new Kit helpers and terminals on top of
 * the documented launch profile.
 */
import { useEffect, useState } from "react";
import type { RuntimeEnvInfo } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore } from "../store";
import { t } from "../i18n";

export function RuntimeEnvSection() {
  const setError = useStore((s) => s.setError);
  const [info, setInfo] = useState<RuntimeEnvInfo | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.runtimeEnvList().then(setInfo).catch(setError);
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    setBusy(true);
    try {
      const names = await api.runtimeEnvSet(name.trim(), value);
      setInfo((current) => (current ? { ...current, names } : current));
      setName("");
      setValue("");
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (n: string) => {
    try {
      const names = await api.runtimeEnvRemove(n);
      setInfo((current) => (current ? { ...current, names } : current));
    } catch (error) {
      setError(error);
    }
  };

  return (
    <section>
      <h3>{t("Runtime environment")}</h3>
      <p className="small muted">
        {t(
          "Agents and the terminal start with a documented environment: PATH, locale and proxies, nothing else. Add a variable here when a skill or MCP server needs one (the imagegen skill's CLI fallback reads",
        )}{" "}
        <span className="mono">OPENAI_API_KEY</span>
        {t(
          ", which is API billing, separate from the ChatGPT subscription login). The value is stored in the {backend}, shown nowhere, and applied to sessions and terminals started after you add it.",
          { backend: info?.backend ?? t("OS keychain") },
        )}
      </p>
      {info && !info.available && <p className="small chip-warn">{t("Secure storage for runtime variables is not available on this platform in this release.")}</p>}
      {info && info.names.length > 0 && (
        <ul className="call-list">
          {info.names.map((n) => (
            <li className="row wrap" key={n}>
              <span className="mono">{n}</span>
              <span className="small muted">{t("value stored in the keychain")}</span>
              <button className="button button-small" onClick={() => void remove(n)} type="button">
                {t("Remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && value) void add();
        }}
      >
        <input aria-label={t("Variable name")} autoCapitalize="characters" className="input mono" disabled={!info?.available} onChange={(e) => setName(e.target.value)} placeholder="OPENAI_API_KEY" spellCheck={false} value={name} />
        <input aria-label={t("Variable value")} autoComplete="off" className="input" disabled={!info?.available} onChange={(e) => setValue(e.target.value)} placeholder={t("value (never shown again)")} type="password" value={value} />
        <button className="button button-primary" disabled={busy || !name.trim() || !value || !info?.available} type="submit">
          {info?.names.includes(name.trim()) ? t("Replace value") : t("Add variable")}
        </button>
      </form>
    </section>
  );
}
