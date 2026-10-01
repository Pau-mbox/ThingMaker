/**
 * The prompt box on the Odyssey view.
 *
 * A run submits its own turns, so a prompt box there is height the plan could
 * be using. The activity strip stays: background work outliving a turn is
 * exactly what it is for, and that was the point of moving it out of the
 * transcript in the first place.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(resolve(here, "components/SessionPanel.tsx"), "utf8");
const styles = readFileSync(resolve(here, "styles.css"), "utf8");

describe("hiding the prompt on the Odyssey view", () => {
  it("hides the prompt box and everything in it", () => {
    const guard = panel.indexOf('{tab !== "odyssey" && (');
    expect(guard).toBeGreaterThan(0);
    // The guard wraps the prompt card, so the attachments strip, the model
    // picker and "stop session" go with it rather than floating alone.
    expect(panel.slice(guard, guard + 400)).toContain('<div className="composer-card">');
  });

  it("leaves the activity strip outside the guard", () => {
    // Moving it inside would undo "something is visible while background work
    // runs", which is the only reason the strip sits in the footer at all.
    expect(panel.indexOf("<ActivityBar")).toBeLessThan(panel.indexOf('{tab !== "odyssey" && ('));
  });

  it("drops the footer padding when there is no prompt box to frame", () => {
    // Otherwise the height saved is handed straight back as empty padding.
    expect(styles).toContain(".composer:not(:has(.composer-card))");
  });
});
