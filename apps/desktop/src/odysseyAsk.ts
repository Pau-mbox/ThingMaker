/**
 * A decision the agent hands to the user (docs/plans/odyssey.md §11.10).
 *
 * The line is for the few things a human genuinely has to decide — an
 * ambiguous requirement, a fork in the architecture, constraints that
 * conflict, a failure that keeps recurring, a permission the agent cannot
 * grant itself. It does not stop the run: the agent names what it will do
 * meanwhile and carries on; the answer arrives on a later continuation.
 *
 * The Rust engine reads the ask line; this module only labels its kinds.
 */
import { t } from "./i18n";

export const ASK_KINDS = ["ambiguity", "architecture", "conflict", "failure", "permission"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

export const ASK_KIND_LABEL: Record<AskKind, string> = {
  ambiguity: t("Ambiguous requirement"),
  architecture: t("Architectural fork"),
  conflict: t("Conflicting constraints"),
  failure: t("Repeated failure"),
  permission: t("Permission needed"),
};
