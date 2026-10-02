/**
 * Planning a goal from a document (docs/plans/odyssey.md §3.1).
 *
 * A dropped roadmap is not parsed for milestones. It is handed to the session's
 * model, which reads it and proposes the plan in a block the Rust engine parses
 * back. The division is the same one the rest of Big Thing keeps: the model
 * proposes, the record decides, and a human presses Start before anything runs.
 *
 * What is left here is what the screen needs to describe a plan.
 */
import type { CheckKind, OdysseyRecord } from "@thingmaker/contracts";

/** Largest document handed to a model in one planning turn. */
export const MAX_PLAN_DOCUMENT_BYTES = 64 * 1024;

/** Whether a plan has nothing Big Thing can verify by itself. */
export function allManual(milestones: { checkKind: CheckKind; checkSpec?: string | null }[]): boolean {
  return milestones.length > 0 && milestones.every((milestone) => milestone.checkKind === "manual" || !milestone.checkSpec);
}

/** A one-line description of the plan a goal was created from, for the UI. */
export function planSummary(goal: Pick<OdysseyRecord, "planSource" | "planDocumentBytes">): string | null {
  if (!goal.planSource && !goal.planDocumentBytes) return null;
  const size = goal.planDocumentBytes ? `${Math.max(1, Math.round(goal.planDocumentBytes / 1024))} KB` : null;
  return [goal.planSource ?? "a document", size].filter(Boolean).join(" · ");
}
