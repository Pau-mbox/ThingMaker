/**
 * How a milestone's check reads (docs/plans/odyssey.md §4.2).
 *
 * The prompts Big Thing submits to the session — the briefing and each
 * continuation — are built by the Rust engine. The screen phrases a check
 * the same way they do, so what the user reads is what the model was told.
 */
import type { CheckKind } from "@thingmaker/contracts";
import { t } from "./i18n";

/** Human phrasing for a milestone's check, as the engine's prompts word it. */
export function checkLabel(kind: CheckKind, spec: string | null | undefined): string {
  switch (kind) {
    case "command":
      return spec ? t("check: `{command}` must exit 0", { command: spec }) : t("check: a command that must exit 0 (not set yet)");
    case "tests_pass":
      return spec ? t("check: `{command}` must exit 0", { command: spec }) : t("check: a test command that must exit 0 (not set yet)");
    case "files_exist":
      return spec ? t("check: these files must exist: {files}", { files: spec.split("\n").filter(Boolean).join(", ") }) : t("check: files that must exist (not set yet)");
    case "manual":
      return t("check: the user ticks it");
  }
}
