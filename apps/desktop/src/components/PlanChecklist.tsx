/**
 * The agent's plan as a checklist (ACP `plan` updates).
 *
 * Claude Code's todo list, Codex's turn plan and anything else an adapter
 * reports as plan entries are drawn the same way: a card in the turn's flow,
 * which is the record, and a bar pinned above the composer while steps
 * remain, which is where you look to see how far along the agent is.
 */
import { useState } from "react";
import type { PlanContent, PlanEntry } from "@thingmaker/contracts";
import { Markdown } from "../markdown";
import { IconCheck, IconChevron, IconX } from "./icons";

type Status = "completed" | "in_progress" | "pending";

function statusOf(entry: PlanEntry): Status {
  if (entry.status === "completed") return "completed";
  if (entry.status === "in_progress") return "in_progress";
  return "pending";
}

const STATUS_WORD: Record<Status, string> = { completed: "done", in_progress: "in progress", pending: "to do" };

export type PlanProgress = { done: number; total: number; current: PlanEntry | null; next: PlanEntry | null };

export function planProgress(plan: PlanContent): PlanProgress | null {
  if (plan.planType !== "items") return null;
  return {
    done: plan.entries.filter((entry) => statusOf(entry) === "completed").length,
    total: plan.entries.length,
    current: plan.entries.find((entry) => statusOf(entry) === "in_progress") ?? null,
    next: plan.entries.find((entry) => statusOf(entry) === "pending") ?? null,
  };
}

/** The plan's words, for transcript search. */
export function planText(plan: PlanContent): string {
  switch (plan.planType) {
    case "items":
      return plan.entries.map((entry) => entry.content).join("\n");
    case "markdown":
      return plan.content;
    case "file":
      return plan.uri;
    default:
      return plan.originalType;
  }
}

function PlanItems({ entries }: { entries: PlanEntry[] }) {
  return (
    <ol className="plan-list">
      {entries.map((entry, index) => {
        const status = statusOf(entry);
        return (
          <li className={`plan-item plan-${status}`} key={`${index}|${entry.content}`}>
            <span aria-hidden="true" className="plan-mark">
              {status === "completed" && <IconCheck size={10} />}
            </span>
            <span className="plan-text">{entry.content}</span>
            {entry.priority === "high" && <span className="chip small plan-priority">high</span>}
            <span className="sr-only">, {STATUS_WORD[status]}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function PlanCard({ plan }: { plan: PlanContent }) {
  const progress = planProgress(plan);
  return (
    <div className="card card-plan">
      <div className="plan-head small">
        <strong>Plan</strong>
        {progress && (
          <span className="muted">
            {" "}
            · {progress.done} of {progress.total} done
          </span>
        )}
      </div>
      {plan.planType === "items" ? (
        <PlanItems entries={plan.entries} />
      ) : plan.planType === "markdown" ? (
        <Markdown source={plan.content} />
      ) : plan.planType === "file" ? (
        <span className="mono small">{plan.uri}</span>
      ) : (
        <span className="small muted">a plan of a kind this version does not draw ({plan.originalType})</span>
      )}
    </div>
  );
}

/**
 * The latest plan, pinned above the composer. Folded to one line by default:
 * how many steps are done and what the agent is on. It leaves once every step
 * is done and the turn is over, and hiding it lasts until the plan changes.
 */
export function PlanBar({ plan, active }: { plan: PlanContent; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState<string | null>(null);
  if (plan.planType !== "items" || plan.entries.length === 0) return null;
  const progress = planProgress(plan) as PlanProgress;
  const signature = JSON.stringify(plan.entries.map((entry) => [entry.content, entry.status ?? null]));
  const finished = progress.done === progress.total;
  if (hidden === signature || (finished && !active)) return null;
  const headline = progress.current?.content ?? (finished ? "All steps done" : progress.next ? `Next: ${progress.next.content}` : "");
  return (
    <div className="plan-bar">
      <div className="plan-bar-row">
        <button aria-expanded={open} className="plan-bar-head" onClick={() => setOpen(!open)} title={open ? "Fold the plan" : "Show every step"} type="button">
          <IconChevron open={open} size={12} />
          <span className="plan-bar-count">
            Plan {progress.done}/{progress.total}
          </span>
          <span className="plan-bar-current">{headline}</span>
        </button>
        <button aria-label="Hide the plan until it changes" className="icon-button icon-button-xs" onClick={() => setHidden(signature)} title="Hide until the plan changes" type="button">
          <IconX size={12} />
        </button>
      </div>
      <div aria-hidden="true" className="plan-meter">
        <span style={{ width: `${(100 * progress.done) / progress.total}%` }} />
      </div>
      {open && <PlanItems entries={plan.entries} />}
    </div>
  );
}
