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
export const ASK_KINDS = ["ambiguity", "architecture", "conflict", "failure", "permission"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

export const ASK_KIND_LABEL: Record<AskKind, string> = {
  ambiguity: "Ambiguous requirement",
  architecture: "Architectural fork",
  conflict: "Conflicting constraints",
  failure: "Repeated failure",
  permission: "Permission needed",
};
