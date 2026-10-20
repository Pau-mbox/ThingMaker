/**
 * The phone's own settings, at the foot of its drawer: how it reaches the
 * computer, whether opening the app asks for the fingerprint or screen lock,
 * and unpairing. Only in the Android app; a desktop browser has none of it.
 */
import { useState } from "react";
import { chooseLanguage, languageChoice, t, type LanguageChoice } from "../i18n";

export function PhoneAppSettings() {
  const native = window.ThingMakerNative;
  const [lock, setLock] = useState(() => native?.lockEnabled?.() ?? true);
  if (!native?.unpair) return null;
  const mode = native.connectionMode?.() === "direct" ? "through your tunnel" : "through your relay";
  return (
    <div className="phone-app-settings small">
      <p className="muted">
        {native.macName?.() ?? "Computer"}, {mode}
      </p>
      {native.setLockEnabled && (
        <label className="check">
          <input
            checked={lock}
            onChange={(event) => {
              native.setLockEnabled?.(event.target.checked);
              setLock(event.target.checked);
            }}
            type="checkbox"
          />{" "}
          Ask for the fingerprint or screen lock when opening
        </label>
      )}
      <label>
        {t("Language")}{" "}
        <select className="select" onChange={(event) => chooseLanguage(event.target.value as LanguageChoice)} value={languageChoice()}>
          <option value="system">{t("Same as the phone")}</option>
          <option value="en">English</option>
          <option value="es">Español</option>
        </select>
      </label>
      <button
        className="link small"
        onClick={() => {
          if (window.confirm("Unpair this phone? You can pair it again from the computer's Settings → Phone.")) native.unpair?.();
        }}
        type="button"
      >
        Unpair this phone
      </button>
    </div>
  );
}
