/**
 * Every string the interface marks for translation has its Spanish, with the
 * same placeholders: a missing one would show in English inside Spanish.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { es } from "./i18n/es";
import { t, useLanguageForTests } from "./i18n";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "i18n" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The literal strings passed to `t(…)` anywhere in the renderer. */
function marked(): Map<string, string> {
  const found = new Map<string, string>();
  const call = /\bt\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const file of sources(__dirname)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(call)) {
      if (match[1] === "`" && match[2]!.includes("${")) continue;
      const literal = JSON.parse(`"${match[2]!.replace(/\\'/g, "'").replace(/"/g, '\\"').replace(/\\`/g, "`")}"`) as string;
      found.set(literal, file);
    }
  }
  return found;
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("Spanish", () => {
  it("translates every marked string, keeping its placeholders", () => {
    const missing: string[] = [];
    const broken: string[] = [];
    for (const [text, file] of marked()) {
      const spanish = es[text];
      if (spanish === undefined) missing.push(`${file.split("/src/")[1]}: ${text}`);
      else if (placeholders(spanish).join() !== placeholders(text).join()) broken.push(`${text} → ${spanish}`);
    }
    expect(missing, "missing Spanish").toEqual([]);
    expect(broken, "placeholders differ").toEqual([]);
  });

  it("fills placeholders, and falls back to English for an unknown string", () => {
    useLanguageForTests("es");
    expect(t("Language")).toBe(es.Language);
    expect(t("A string nobody translated")).toBe("A string nobody translated");
    useLanguageForTests("en");
    expect(t("Connected to {name}", { name: "Mac" })).toBe("Connected to Mac");
  });
});
