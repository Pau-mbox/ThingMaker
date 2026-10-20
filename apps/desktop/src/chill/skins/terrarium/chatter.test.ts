import { afterEach, describe, expect, it } from "vitest";
import { useLanguageForTests } from "../../../i18n";
import { es } from "../../../i18n/es";
import { CHATTER, chatterGap, chatterLine } from "./chatter";
import type { Activity } from "./motion";

const words = (line: string) => line.split(/\s+/).filter(Boolean).length;

describe("helper chatter", () => {
  afterEach(() => useLanguageForTests("en"));

  it("keeps every line to four words at most", () => {
    for (const lines of Object.values(CHATTER))
      for (const line of lines) expect(words(line), line).toBeLessThanOrEqual(4);
  });

  it("has every line in Spanish too, also four words at most", () => {
    for (const lines of Object.values(CHATTER))
      for (const line of lines) {
        const spanish = es[line];
        expect(spanish, line).toBeTypeOf("string");
        expect(words(spanish!), spanish).toBeLessThanOrEqual(4);
      }
  });

  it("says its lines in the interface language", () => {
    useLanguageForTests("es");
    const spanish = new Set(Object.values(CHATTER).flat().map((line) => es[line]));
    for (const activity of Object.keys(CHATTER) as Activity[])
      for (let count = 0; count < 12; count++) {
        const line = chatterLine(activity, 5, count);
        expect(spanish.has(line), line).toBe(true);
        expect(words(line), line).toBeLessThanOrEqual(4);
      }
  });

  it("speaks now and then, not continuously, and varies what it says", () => {
    for (let count = 1; count < 20; count++) expect(chatterGap(5, count)).toBeGreaterThanOrEqual(15);
    const said = new Set(Array.from({ length: 12 }, (_, count) => chatterLine("editing", 5, count)));
    expect(said.size).toBeGreaterThan(3);
  });
});
