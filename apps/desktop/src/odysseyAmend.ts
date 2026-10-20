/**
 * Changing a goal while it runs (docs/plans/odyssey.md §3.2).
 *
 * The user has more to say after the run started. It is carried to the model
 * on its next prompt — never submitted on its own, because the session is
 * usually mid-turn — and the *model* decides where it belongs and when to act
 * on it. The Rust engine carries it and reads the model's answer back; this
 * module only says on screen what happened to it.
 */
import type { AmendmentRecord } from "@thingmaker/contracts";
import { t } from "./i18n";

/** Tellings before it stops asking and hands the amendment back to the user. */
export const MAX_TELLS = 3;

/** How an amendment reads on screen, in the words of what actually happened. */
export function amendmentStatus(record: Pick<AmendmentRecord, "state" | "tellCount" | "kind">): string {
  if (record.kind === "note" && record.state === "applied") return t("delivered");
  switch (record.state) {
    case "pending":
      return t("queued for the next prompt");
    case "told":
      if (record.tellCount >= MAX_TELLS) return t("the agent was told {count} times and has not folded it in — it is yours now", { count: record.tellCount });
      return record.tellCount > 1 ? t("with the agent · told {count} times", { count: record.tellCount }) : t("with the agent");
    case "applied":
      return t("folded into the plan");
    case "discarded":
      return t("discarded");
  }
}
