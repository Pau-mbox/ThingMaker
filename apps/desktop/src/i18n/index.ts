/**
 * The interface's languages: English, and Spanish from a catalog.
 *
 * Strings are written in English in the code and looked up by that English
 * text, so the code reads as it shows: `t("Pair a phone")`. Values go in by
 * name: `t("Connected to {name}", { name })`. A string missing from the
 * catalog shows in English, and a test lists any that are missing.
 *
 * The language is this machine's (or this phone's) choice, kept locally:
 * the system's, English or Español. Changing it reloads the window, which
 * picks up live sessions again from the computer.
 */
import { es } from "./es";

export type Language = "en" | "es";
export type LanguageChoice = "system" | Language;

const KEY = "thingmaker.language";

function systemLanguage(): Language {
  const languages = typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language];
  return languages.some((language) => language?.toLowerCase().startsWith("es")) ? "es" : "en";
}

/** What the person chose; `system` follows the computer's or phone's language. */
export function languageChoice(): LanguageChoice {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "en" || stored === "es" || stored === "system") return stored;
  } catch {
    // No storage: the system's language.
  }
  return "system";
}

function resolve(choice: LanguageChoice): Language {
  return choice === "system" ? systemLanguage() : choice;
}

let current: Language = resolve(languageChoice());

/** The language the interface is in now. */
export function language(): Language {
  return current;
}

/** Keeps the choice and reloads into it. The phone's own screens follow too. */
export function chooseLanguage(choice: LanguageChoice) {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Remembering is a convenience.
  }
  window.ThingMakerNative?.setLanguage?.(choice);
  current = resolve(choice);
  window.location.reload();
}

/** For tests: the language without a reload. */
export function useLanguageForTests(next: Language) {
  current = next;
}

const catalogs: Record<Exclude<Language, "en">, Record<string, string>> = { es };

/** `text` in the interface's language, with `{name}` placeholders filled. */
export function t(text: string, values?: Record<string, string | number>): string {
  const translated = current === "en" ? text : (catalogs[current][text] ?? text);
  if (!values) return translated;
  return translated.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}
