/**
 * The intervention inbox (docs/plans/odyssey.md §11.10): the few things in a
 * run that genuinely need a human, gathered from the record.
 *
 * Everything else the runner handles itself. What lands here: a question
 * the agent handed over, a plan change waiting for a decision, a change the
 * agent was told about three times and did not fold in, a run blocked by a
 * guard, a check that keeps failing, a claim only the user can tick, and the
 * session asking for input the agent cannot give itself. Derived, not stored:
 * the record already holds each fact, this is where they are read together.
 */
import type { AmendmentRecord, MilestoneRecord, OdysseyJournalEntry, OdysseyRecord, PlanChangeRecord, QuestionRecord } from "@thingmaker/contracts";
import { MAX_TELLS } from "./odysseyAmend";

/** Consecutive failed checks on one milestone before it is a decision, not a retry. */
export const REPEATED_FAILURES = 3;

export type InboxItem =
  | { kind: "question"; id: string; at: number; question: QuestionRecord }
  | { kind: "plan_change"; id: string; at: number; change: PlanChangeRecord }
  | { kind: "amendment_stuck"; id: string; at: number; amendment: AmendmentRecord }
  | { kind: "blocked"; id: string; at: number; reason: string }
  | { kind: "repeated_failure"; id: string; at: number; milestone: MilestoneRecord; index: number; failures: number; lastOutput: string }
  | { kind: "claim"; id: string; at: number; milestone: MilestoneRecord; index: number }
  | { kind: "needs_input"; id: string; at: number };

export function inboxItems(input: {
  goal: Pick<OdysseyRecord, "state" | "onReport">;
  milestones: MilestoneRecord[];
  journal: OdysseyJournalEntry[];
  questions: QuestionRecord[];
  planChanges: PlanChangeRecord[];
  amendments: AmendmentRecord[];
  sessionAttention: string | null;
  now: number;
}): InboxItem[] {
  const { goal, milestones, journal, questions, planChanges, amendments, sessionAttention, now } = input;
  const items: InboxItem[] = [];

  for (const question of questions) if (question.state === "open") items.push({ kind: "question", id: `q-${question.id}`, at: question.at, question });
  for (const change of planChanges) if (change.state === "proposed") items.push({ kind: "plan_change", id: `pc-${change.id}`, at: change.at, change });
  for (const amendment of amendments) {
    if (amendment.kind !== "note" && amendment.state === "told" && amendment.tellCount >= MAX_TELLS) items.push({ kind: "amendment_stuck", id: `am-${amendment.id}`, at: amendment.toldAt ?? amendment.at, amendment });
  }

  if (goal.state === "blocked") {
    // The newest guard or blocked report, whichever came last: a report of
    // `blocked` carries the agent's own reason, which is the one to read.
    const cause = journal.find((entry) => entry.kind === "guard" || (entry.kind === "report" && /blocked$/.test(entry.summary)));
    const reason = cause?.kind === "report" ? `The agent reported milestone ${cause.summary.replace(/\D/g, "")} blocked: ${cause.detail ?? ""}`.trim() : (cause?.summary ?? "The run is blocked.");
    items.push({ kind: "blocked", id: "blocked", at: cause?.at ?? now, reason });
  }

  // A check that failed twice in a row on the same milestone is no longer a
  // retry the agent will fix on its own; the newest rows decide, so a pass
  // after the failures clears it.
  for (const [index, milestone] of milestones.entries()) {
    if (milestone.state === "verified" || milestone.state === "skipped") continue;
    const checks = journal.filter((entry) => entry.kind === "check" && entry.milestoneId === milestone.id && /passed|failed/.test(entry.summary));
    let failures = 0;
    for (const entry of checks) {
      if (/failed/.test(entry.summary)) failures += 1;
      else break;
    }
    if (failures >= REPEATED_FAILURES) {
      items.push({ kind: "repeated_failure", id: `fail-${milestone.id}`, at: checks[0]?.at ?? now, milestone, index, failures, lastOutput: checks[0]?.detail ?? "" });
    }
    // A claim on a milestone only the user can verify, when the run is set to
    // wait for that, is a decision the run is parked on.
    if (milestone.state === "reported" && milestone.checkKind === "manual" && goal.onReport === "wait") {
      items.push({ kind: "claim", id: `claim-${milestone.id}`, at: milestone.checkRanAt ?? now, milestone, index });
    }
  }

  if (sessionAttention === "needs_input") items.push({ kind: "needs_input", id: "needs-input", at: now });

  return items.sort((a, b) => b.at - a.at);
}
