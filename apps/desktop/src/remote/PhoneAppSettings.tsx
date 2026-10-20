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
  const direct = native.connectionMode?.() === "direct";
  const name = native.macName?.() ?? t("Computer");
  return (
    <div className="phone-app-settings small">
      <p className="muted">
        {direct ? t("{name}, through your tunnel", { name }) : t("{name}, through your relay", { name })}
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
          {t("Ask for the fingerprint or screen lock when opening")}
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
          if (window.confirm(t("Unpair this phone? You can pair it again from the computer's Settings → Phone."))) native.unpair?.();
        }}
        type="button"
      >
        {t("Unpair this phone")}
      </button>
    </div>
  );
}
